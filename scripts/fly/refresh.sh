#!/usr/bin/env bash
# Builder run (the daily, one-shot big machine).
#
# This is the "spawn a big node, rescan every base + its git(s), publish fresh
# indexes, then swap them under the little node" step — done the corruption-safe
# way. It runs to completion and exits; on a Fly *scheduled* machine (--schedule
# daily --restart no) the machine then stops until the next tick, so the big
# node only costs money for the few minutes it actually builds.
#
# It builds every base listed in scripts/fly/bases.json (the golden default
# `demo` = this repo, plus one base per eval suite repo — see gen-bases.mjs),
# fail-fast: each base has its own snapshot prefix, its own immutable versions,
# and its own atomic pointer, but the first base to fail aborts the run — later
# bases do not build and the serving roll is skipped, so a bad run never
# partially rolls the fleet onto a mixed fresh/stale (or worse, broken) set.
#
# Per-base flow:
#   1. Warm path (a latest.json pointer exists): download the current snapshot,
#      then `kb-server refresh --from cur --repos ... --out new` does the
#      adopt → rehydrate-from-provenance → git pull + hash-diffed incremental
#      reindex → VACUUM INTO export, all in one typed subcommand (packages/
#      kb-server/src/refresh-cli.ts, FR-18) — the same one scripts/gcp/refresh.sh
#      calls, so this warm-path fix lands once for both platforms.
#   2. Cold path (first run, no pointer): `kb-server refresh --repos ... --out
#      new` (no --from) clones fresh and exports. Object-store transport stays
#      here in shell — kb-server never learns about gs://\s3:// (see FR-18).
#   3. Publish: upload the fresh snapshot to an IMMUTABLE version prefix, then
#      atomically flip latest.json (the single commit point).
#   4. Prune old immutable versions (keep SNAPSHOT_KEEP).
# After all bases publish, the serving node is rolled ONCE (health-gated) so it
# re-adopts the whole fresh set.
#
# Nothing here ever mutates a shared or live volume, so no index can be corrupted
# mid-flight: readers only ever see a fully-uploaded, sha256-stamped version that
# latest.json already points at.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

require_bucket

# Guard against a second overlapping invocation (e.g. the machine's entrypoint
# got respawned after a crash mid-run while the old process tree survived as
# orphans) — without this, two copies iterate the same base list concurrently,
# double every cold build's resource usage, and neither one reliably wins.
# mkdir is atomic across POSIX filesystems, so this needs no extra dependency.
LOCK_DIR="${LOCK_DIR:-/tmp/refresh.lock}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "error: another refresh.sh is already running (lock: $LOCK_DIR) — exiting." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

WORK="${WORK_DIR:-/work}"
# SNAPSHOT_NO_REPOS=true ships tiny serve-only artifacts (drops the repo working
# trees) — the right default when serving many bases on a small node. Answers come
# from the SQLite index either way; per-base source links come from each snapshot's
# manifest provenance (gitUrl/branch), which is recorded even with --no-repos.
# Set SNAPSHOT_NO_REPOS=false to carry full working trees. Only the exact string
# "true" enables it (the true/false convention — "false" must NOT enable it).
REPOS_FLAG=""
if [[ "${SNAPSHOT_NO_REPOS:-true}" == "true" ]]; then REPOS_FLAG="--no-repos"; fi
VERSION="$(date -u +%Y%m%dT%H%M%SZ)"

rm -rf "$WORK"; mkdir -p "$WORK"

# Build, snapshot, and publish one base. Runs in a subshell (see the loop);
# a failure aborts the rest of the run. Args: <name> <repo-url> <branch>.
build_base() {
  local base="$1" repo="$2" branch="$3"
  local prefix cur new pointer prev digest kb_home repos_arg
  prefix="$(snapshot_prefix_for "$base")"
  cur="$WORK/$base/cur"
  new="$WORK/$base/new"
  kb_home="$WORK/$base/home"
  rm -rf "$WORK/$base"; mkdir -p "$new" "$kb_home"

  echo "▶ building base=$base repo=${repo:-<none>} version=$VERSION repos_flag=${REPOS_FLAG:-<full>}"
  pointer="$(s3_read_pointer "$prefix")"
  # FORCE_COLD=true bypasses the warm path even when a pointer exists — e.g. to
  # rebuild a base from scratch after a suspected bad incremental reindex.
  if [[ "${FORCE_COLD:-false}" == "true" && -n "$pointer" ]]; then
    echo "  · FORCE_COLD=true: ignoring existing pointer, forcing a cold rebuild"
    pointer=""
  fi
  repos_arg="${repo}${branch:+#$branch}"

  # `kb-server refresh` owns the adopt/rehydrate/reindex-or-clone/export
  # sequence (and its own throwaway bootstrap-child spawn+health-wait+kill) —
  # see packages/kb-server/src/refresh-cli.ts (FR-18 in SERVER.spec.md). This
  # script's only remaining job is object-store transport (kb-server never
  # touches gs://\s3://) and the publish/pointer-flip/prune below.
  local refresh_args=(--base "$base" --out "$new" --json
    --timeout "$(( ${COLD_BUILD_TIMEOUT:-1800} * 1000 ))")
  [[ -n "$REPOS_FLAG" ]] && refresh_args+=("$REPOS_FLAG")

  if [[ -n "$pointer" ]]; then
    # ---- Warm path: adopt previous snapshot, rehydrate the repo from
    #      provenance, reindex changed files, then export. --------------------
    prev="$(printf '%s' "$pointer" | json_get version)"
    echo "  · warm path: adopting previous snapshot version=$prev, then rehydrate+reindex"
    mkdir -p "$cur"
    s3_pull_prefix "$prefix/$prev" "$cur"
    refresh_args+=(--from "$cur" --repos "$repos_arg")
  else
    # ---- Cold path: first-ever build from the base's repo --------------------
    if [[ -z "$repo" ]]; then
      echo "error: base '$base' has no repo_url and no existing snapshot — cannot cold-build." >&2
      return 1
    fi
    echo "  · cold path: no pointer yet — building from $repo"
    refresh_args+=(--repos "$repos_arg")
  fi

  KB_HOME="$kb_home" kb_server refresh "${refresh_args[@]}"

  if [[ ! -f "$new/kb-snapshot.json" ]]; then
    echo "error: builder produced no snapshot for base '$base' at $new." >&2
    return 1
  fi
  digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.digest?.index??"")' "$new/kb-snapshot.json")"
  echo "  · fresh snapshot ready base=$base indexDigest=${digest:0:12}…"

  # ---- Publish: immutable version first, THEN atomic pointer flip -----------
  echo "  · uploading immutable version → $prefix/$VERSION"
  s3_push_prefix "$new" "$prefix/$VERSION"

  cat > "$WORK/$base/latest.json" <<JSON
{
  "version": "$VERSION",
  "base": "$base",
  "indexDigest": "$digest",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  echo "  · flipping pointer latest.json → $VERSION (commit point) for base=$base"
  s3_write_pointer "$WORK/$base/latest.json" "$prefix"

  # ---- Prune old immutable versions for this base ---------------------------
  echo "  · pruning old versions for base=$base (keeping newest $SNAPSHOT_KEEP)"
  local versions count v
  mapfile -t versions < <(
    _s3 ls "s3://${BUCKET_NAME}/${prefix}/" \
      | awk '/PRE/ {gsub(/\//,"",$2); print $2}' \
      | sort
  )
  count=${#versions[@]}
  if (( count > SNAPSHOT_KEEP )); then
    for v in "${versions[@]:0:count-SNAPSHOT_KEEP}"; do
      [[ "$v" == "$VERSION" ]] && continue
      echo "    - deleting $prefix/$v"
      _s3 rm --recursive "s3://${BUCKET_NAME}/${prefix}/$v/" >/dev/null || true
    done
  fi

  echo "  ✓ base '$base' published $VERSION"
  # Free the working tree for this base before moving on (keeps disk bounded).
  rm -rf "$WORK/$base"
}

# ---- Build every base, fail-fast on the first failure -----------------------
# A base that fails aborts the whole run rather than being skipped: rolling the
# serving node onto a set where one base's rebuild is suspect (rather than
# just stale) risks serving a broken index instead of the previous good one,
# so later bases do not build and the roll is skipped entirely.
built=()
failed_base=""
while IFS=$'\t' read -r name repo branch _is_default; do
  [[ -z "${name:-}" ]] && continue
  # ONLY_BASES: comma-separated allowlist for scoping a run to specific bases
  # (e.g. incident recovery/debugging one base without paying for a full
  # 10-base run). Unset/empty means "build everything" — unchanged default.
  if [[ -n "${ONLY_BASES:-}" ]]; then
    case ",${ONLY_BASES}," in
      *",${name},"*) ;;
      *) continue ;;
    esac
  fi
  # Run each base in its own subshell. `set +e` around it keeps this failure
  # from aborting the outer loop before it can log and break cleanly; the
  # explicit `set -e` INSIDE the subshell (honored because the subshell is not
  # an if/&&/|| operand) makes build_base stop at its first failing step.
  # `< /dev/null`: the outer loop's stdin is the `each_base` process-
  # substitution pipe (`done < <(each_base)`). `kb-server refresh` spawns its
  # own bootstrap child, which inherits stdio by default — if it (or anything
  # else in this subshell's tree) so much as touches fd 0, it can steal bytes
  # meant for the loop's next `read`, silently truncating the run after a
  # base picked at random by timing (observed: after 1 base one run, after 4
  # the next). Detaching this subshell's stdin from that pipe entirely makes
  # it impossible for anything inside build_base to interfere with it.
  set +e
  ( set -euo pipefail; build_base "$name" "$repo" "$branch" ) < /dev/null
  rc=$?
  set -e
  if (( rc == 0 )); then
    built+=("$name")
  else
    echo "  ✗ base '$name' failed — aborting builder, not building further bases." >&2
    failed_base="$name"
    break
  fi
done < <(each_base)

echo "── build summary: ${#built[@]} published [${built[*]:-}]${failed_base:+ · aborted at '$failed_base'}"

if [[ -n "$failed_base" ]]; then
  echo "error: base '$failed_base' failed — not rolling the serving node." >&2
  exit 1
fi

if (( ${#built[@]} == 0 )); then
  echo "error: no base built successfully — not rolling the serving node." >&2
  exit 1
fi

# ---- Swap: roll the serving node once onto the fresh set --------------------
if [[ -n "${FLY_API_TOKEN:-}" && -n "${SERVE_APP:-}" ]]; then
  echo "▶ rolling serving app '$SERVE_APP' onto version=$VERSION (all bases)"
  node "$SELF_DIR/roll-serving.mjs"
else
  echo "▶ skipping serving roll (set FLY_API_TOKEN + SERVE_APP to enable)."
  echo "  the serving node will pick up the fresh snapshots on its next restart."
fi

echo "✅ builder run complete: published + swapped ${#built[@]} base(s)."
