#!/usr/bin/env bash
# Builder run (the daily, one-shot big machine).
#
# This is the "spawn a big node, rescan every base + its git(s), publish fresh
# indexes, then swap them under the little node" step — done the corruption-safe
# way. It runs to completion and exits; on a Fly *scheduled* machine (--schedule
# daily --restart no) the machine then stops until the next tick, so the big
# node only costs money for the few minutes it actually builds.
#
# It builds EVERY base listed in scripts/fly/bases.json (the golden default
# `demo` = this repo, plus one base per eval suite repo — see gen-bases.mjs).
# Each base is independent: its own snapshot prefix, its own immutable versions,
# its own atomic pointer. A base that fails to build leaves its previous snapshot
# untouched (the others still publish), so one flaky clone never takes the demo
# down.
#
# Per-base flow:
#   1. Warm path (a latest.json pointer exists): download the current snapshot
#      and run `kb-server scan --from cur --out new` — adopt → git pull +
#      hash-diffed incremental reindex → VACUUM INTO export. Cheap and incremental.
#   2. Cold path (first run, no pointer): boot `kb-server start` (auto) which
#      clones the base's repo and builds, wait for /healthz ok, then export.
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

# Send SIGTERM, then escalate to SIGKILL if the process outlives a short grace
# period. A plain SIGTERM alone was observed leaving cold-build servers running
# indefinitely after their base's step returned, competing with later bases for
# the same CPUs (interleaved logs from bases that should already be done).
force_kill() {
  local pid="$1" waited=0
  kill "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= 10 )); then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    (( waited++ ))
  done
}

# Build, snapshot, and publish one base. Runs in a subshell (see the loop) so a
# failure is isolated to that base. Args: <name> <repo-url> <branch>.
build_base() {
  local base="$1" repo="$2" branch="$3"
  local prefix cur new pointer prev digest
  prefix="$(snapshot_prefix_for "$base")"
  cur="$WORK/$base/cur"
  new="$WORK/$base/new"
  rm -rf "$WORK/$base"; mkdir -p "$cur" "$new"

  echo "▶ building base=$base repo=${repo:-<none>} version=$VERSION repos_flag=${REPOS_FLAG:-<full>}"
  pointer="$(s3_read_pointer "$prefix")"

  if [[ -n "$pointer" ]]; then
    # ---- Warm path: incremental rescan from the previous snapshot -----------
    prev="$(printf '%s' "$pointer" | json_get version)"
    echo "  · warm path: adopting previous snapshot version=$prev"
    s3_pull_prefix "$prefix/$prev" "$cur"
    # scan = adopt (--from, sha256-verified) → git pull + incremental reindex → export.
    kb_server scan \
      --base "$base" \
      --from "$cur" \
      --out "$new" \
      ${REPOS_FLAG} \
      --json
  else
    # ---- Cold path: first-ever build from the base's repo --------------------
    if [[ -z "$repo" ]]; then
      echo "error: base '$base' has no repo_url and no existing snapshot — cannot cold-build." >&2
      return 1
    fi
    echo "  · cold path: no pointer yet — building from $repo"
    local kb_home port server_pid deadline health
    kb_home="$WORK/$base/home"
    port="${PORT:-38117}"
    mkdir -p "$kb_home"
    # Per-base cold build: KB_HOME + KB_BASE + KB_GIT_REPOS scoped to this base so
    # the auto bootstrap clones exactly this repo into ~/.kb/sessions/<base>.
    KB_HOME="$kb_home" KB_BASE="$base" \
      KB_GIT_REPOS="${repo}${branch:+#$branch}" \
      PORT="$port" \
      node "$KB_SERVER_JS" start --base "$base" --bootstrap-policy auto &
    server_pid=$!
    # shellcheck disable=SC2064
    trap "force_kill $server_pid" RETURN
    echo "  · waiting for first index (GET /healthz ok:true) …"
    deadline=$(( $(date +%s) + ${COLD_BUILD_TIMEOUT:-1800} ))
    until health="$(curl -fsS "http://127.0.0.1:${port}/healthz" 2>/dev/null)" \
          && [[ "$(printf '%s' "$health" | json_get ok)" == "true" ]]; do
      if (( $(date +%s) > deadline )); then
        echo "error: cold build for base '$base' did not become ready before COLD_BUILD_TIMEOUT." >&2
        return 1
      fi
      sleep 5
    done
    echo "  · first index ready; exporting"
    KB_HOME="$kb_home" kb_server export --base "$base" --out "$new" ${REPOS_FLAG} --force
    force_kill "$server_pid"
    trap - RETURN
  fi

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

# ---- Build every base (isolated; one failure doesn't sink the others) -------
built=()
failures=()
while IFS=$'\t' read -r name repo branch _is_default; do
  [[ -z "${name:-}" ]] && continue
  # Isolate each base in its own subshell. `set +e` around it keeps a base
  # failure from aborting the whole run; the explicit `set -e` INSIDE the
  # subshell (honored because the subshell is not an if/&&/|| operand) makes
  # build_base stop at its first failing step.
  set +e
  ( set -euo pipefail; build_base "$name" "$repo" "$branch" )
  rc=$?
  set -e
  if (( rc == 0 )); then
    built+=("$name")
  else
    echo "  ✗ base '$name' failed — its previous snapshot stays live" >&2
    failures+=("$name")
  fi
done < <(each_base)

echo "── build summary: ${#built[@]} published [${built[*]:-}] · ${#failures[@]} failed [${failures[*]:-}]"

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

if (( ${#failures[@]} > 0 )); then
  echo "⚠ builder run complete WITH FAILURES: [${failures[*]}] kept their previous snapshots." >&2
  exit 1
fi
echo "✅ builder run complete: published + swapped ${#built[@]} base(s)."
