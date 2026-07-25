#!/usr/bin/env bash
# Builder run (the hourly/one-shot big Cloud Run Job).
#
# Spawn a big node, rescan every base + its git(s), publish fresh indexes to GCS,
# then exit — the corruption-safe way. Native `gcloud storage`, no AWS.
#
# Per-base flow:
#   1. Warm path (a latest.json pointer exists): download the current snapshot,
#      then `kb-server refresh --from cur --repos ... --out new` does the
#      adopt → rehydrate-from-provenance (+ fold in newly-declared repos) → git
#      pull + hash-diffed incremental reindex → VACUUM INTO export, all in one
#      typed subcommand (packages/kb-server/src/refresh-cli.ts, FR-18 in
#      SERVER.spec.md) — the same one scripts/fly/refresh.sh calls, so this
#      warm-path logic lands once for both platforms instead of drifting.
#   2. Cold path (first run, no pointer): `kb-server refresh --repos ... --out
#      new` (no --from) clones fresh and exports. Object-store transport stays
#      here in shell — kb-server never learns about gs://\s3:// (see FR-18).
#   3. Publish: upload the fresh snapshot to an IMMUTABLE version prefix, then
#      atomically flip latest.json (the single commit point).
#   4. Prune old immutable versions (keep SNAPSHOT_KEEP).
#
# Rolling the serving node onto the fresh snapshot is done OUT OF BAND on GCP
# (a Cloud Scheduler → kb-roll Job forces a new Cloud Run revision) — see
# deploy-kb.sh. This script just publishes and exits.
#
# Nothing here ever mutates a shared or live volume, so no index can be corrupted
# mid-flight: readers only ever see a fully-uploaded, sha256-stamped version that
# latest.json already points at.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

require_bucket

# Guard against a second overlapping invocation within one container. (Cloud Run
# Job executions are isolated, so this does NOT prevent two concurrent executions
# — the scheduler cadence + task-timeout handle that; see deploy-kb.sh.)
LOCK_DIR="${LOCK_DIR:-/tmp/refresh.lock}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "error: another refresh.sh is already running (lock: $LOCK_DIR) — exiting." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

WORK="${WORK_DIR:-/work}"
# SNAPSHOT_NO_REPOS=true ships tiny serve-only artifacts (drops repo working
# trees); per-base source links still resolve from manifest provenance. Only the
# exact string "true" enables it.
REPOS_FLAG=""
if [[ "${SNAPSHOT_NO_REPOS:-true}" == "true" ]]; then REPOS_FLAG="--no-repos"; fi
VERSION="$(date -u +%Y%m%dT%H%M%SZ)"

rm -rf "$WORK"; mkdir -p "$WORK"

# Build, snapshot, and publish one base. Runs in a subshell (see the loop) so a
# failure is isolated to that base. Args: <name> <repo-url> <branch>.
build_base() {
  local base="$1" repos="$2"
  local prefix cur new pointer prev digest force_cold kb_home
  prefix="$(snapshot_prefix_for "$base")"
  cur="$WORK/$base/cur"
  new="$WORK/$base/new"
  kb_home="$WORK/$base/home"
  rm -rf "$WORK/$base"; mkdir -p "$new" "$kb_home"

  echo "▶ building base=$base repos=[${repos:-<none>}] version=$VERSION repos_flag=${REPOS_FLAG:-<full>}"
  pointer="$(gcs_read_pointer "$prefix")"

  # A one-off full rebuild — onboarding new repos, which the warm rescan does NOT
  # fold in — is requested per-execution via FORCE_COLD=true or REBUILD_BASES
  # (space/comma list of base names). We take the cold clone-all path but never
  # touch the live pointer/snapshot until the atomic flip at the end, so serving
  # keeps running the old snapshot with zero downtime until kb-roll swaps it.
  force_cold=false
  if [[ "${FORCE_COLD:-false}" == "true" ]] || [[ " ${REBUILD_BASES:-} " == *" $base "* ]]; then
    force_cold=true
    echo "  · force-cold requested for base=$base (ignoring live pointer; old snapshot stays until flip)"
  fi

  # `kb-server refresh` owns the adopt/rehydrate-and-fold/reindex-or-clone/export
  # sequence (and its own throwaway bootstrap-child spawn+health-wait+kill) —
  # see packages/kb-server/src/refresh-cli.ts (FR-18 in SERVER.spec.md). This
  # script's only remaining job is object-store transport (kb-server never
  # touches gs://\s3://) and the publish/pointer-flip/prune below.
  local refresh_args=(--base "$base" --out "$new" --json
    --timeout "$(( ${COLD_BUILD_TIMEOUT:-1800} * 1000 ))")
  [[ -n "$REPOS_FLAG" ]] && refresh_args+=("$REPOS_FLAG")
  [[ -n "$repos" ]] && refresh_args+=(--repos "$repos")

  if [[ -n "$pointer" && "$force_cold" != "true" ]]; then
    # ---- Warm path: adopt previous snapshot, rehydrate + fold declared repos,
    #      reindex changed files, then export. --------------------------------
    prev="$(printf '%s' "$pointer" | json_get version)"
    echo "  · warm path: adopting previous snapshot version=$prev, then rehydrate+fold+reindex"
    gcs_pull_prefix "$prefix/$prev" "$cur"
    refresh_args+=(--from "$cur")
  else
    # ---- Cold path: first-ever build from the base's repo --------------------
    if [[ -z "$repos" ]]; then
      echo "error: base '$base' has no repos and no existing snapshot — cannot cold-build." >&2
      return 1
    fi
    echo "  · cold path: building base from repos: $repos"
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
  gcs_push_prefix "$new" "$prefix/$VERSION"

  cat > "$WORK/$base/latest.json" <<JSON
{
  "version": "$VERSION",
  "base": "$base",
  "indexDigest": "$digest",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  echo "  · flipping pointer latest.json → $VERSION (commit point) for base=$base"
  gcs_write_pointer "$WORK/$base/latest.json" "$prefix"

  # ---- Prune old immutable versions for this base ---------------------------
  echo "  · pruning old versions for base=$base (keeping newest $SNAPSHOT_KEEP)"
  local versions count v
  mapfile -t versions < <(gcs_list_versions "$prefix")
  count=${#versions[@]}
  if (( count > SNAPSHOT_KEEP )); then
    for v in "${versions[@]:0:count-SNAPSHOT_KEEP}"; do
      [[ "$v" == "$VERSION" ]] && continue
      echo "    - deleting $prefix/$v"
      gcs_rm_version "$prefix" "$v"
    done
  fi

  echo "  ✓ base '$base' published $VERSION"
  rm -rf "$WORK/$base"
}

# ---- Build every base (isolated; one failure doesn't sink the others) -------
built=()
failures=()
while IFS=$'\t' read -r name repos _reserved _is_default; do
  [[ -z "${name:-}" ]] && continue
  # < /dev/null: detach this subshell's stdin from the `each_base` process-
  # substitution pipe feeding the loop's own `read` — see scripts/fly/refresh.sh
  # for why (kb-server refresh's bootstrap child can otherwise steal bytes
  # from it and silently truncate the run after a random number of bases).
  set +e
  ( set -euo pipefail; build_base "$name" "$repos" ) < /dev/null
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
  echo "error: no base built successfully." >&2
  exit 1
fi

echo "▶ snapshots published. The serving node adopts them when it is rolled"
echo "  (Cloud Scheduler → kb-roll Job forces a new Cloud Run revision)."

if (( ${#failures[@]} > 0 )); then
  echo "⚠ builder run complete WITH FAILURES: [${failures[*]}] kept their previous snapshots." >&2
  exit 1
fi
echo "✅ builder run complete: published ${#built[@]} base(s)."
