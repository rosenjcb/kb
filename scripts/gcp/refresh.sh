#!/usr/bin/env bash
# Builder run (the hourly/one-shot big Cloud Run Job).
#
# Spawn a big node, rescan every base + its git(s), publish fresh indexes to GCS,
# then exit — the corruption-safe way. Native `gcloud storage`, no AWS.
#
# Per-base flow:
#   1. Warm path (a latest.json pointer exists): download the current snapshot
#      and run `kb-server scan --from cur --out new` — adopt → git pull +
#      hash-diffed incremental reindex → VACUUM INTO export. Cheap and incremental.
#   2. Cold path (first run, no pointer): boot `kb-server start` (auto), which
#      clones the base's repo and builds, wait for /healthz ok, then export.
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

# SIGTERM then escalate to SIGKILL if the process outlives a short grace period.
force_kill() {
  local pid="$1" waited=0
  kill "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= 10 )); then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# Build, snapshot, and publish one base. Runs in a subshell (see the loop) so a
# failure is isolated to that base. Args: <name> <repo-url> <branch>.
build_base() {
  local base="$1" repos="$2"
  local prefix cur new pointer prev digest force_cold
  prefix="$(snapshot_prefix_for "$base")"
  cur="$WORK/$base/cur"
  new="$WORK/$base/new"
  rm -rf "$WORK/$base"; mkdir -p "$cur" "$new"

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

  if [[ -n "$pointer" && "$force_cold" != "true" ]]; then
    # ---- Warm path: adopt previous snapshot, rehydrate + fold declared repos,
    #      reindex changed files, then export. --------------------------------
    # Snapshots ship WITHOUT repo clones (--no-repos), so a plain `scan` has
    # nothing on disk to reindex. Instead: adopt the previous index, then boot
    # `start --bootstrap-policy auto` — its warm-volume task re-clones every repo
    # from manifest provenance AND folds in any newly-declared `KB_GIT_REPOS`
    # (incrementally, without rebuilding the big repo from scratch). Once that
    # settles (health ok:true, indexing:false), a `scan` pass does the git pull +
    # hash-diff reindex so new commits land too, then exports the fresh snapshot.
    prev="$(printf '%s' "$pointer" | json_get version)"
    echo "  · warm path: adopting previous snapshot version=$prev, then rehydrate+fold+reindex"
    gcs_pull_prefix "$prefix/$prev" "$cur"

    local kb_home port server_pid deadline health berr
    kb_home="$WORK/$base/home"
    port="${PORT:-38117}"
    mkdir -p "$kb_home"
    # Adopt the previous index into the base (no clones yet — snapshot is --no-repos).
    KB_HOME="$kb_home" node "$KB_SERVER_JS" import --base "$base" --from "$cur" --force
    # Boot frozen-auto: re-clone provenance repos + fold in newly-declared ones.
    KB_HOME="$kb_home" KB_BASE="$base" KB_GIT_REPOS="$repos" PORT="$port" \
      node "$KB_SERVER_JS" start --base "$base" --bootstrap-policy auto &
    server_pid=$!
    # shellcheck disable=SC2064
    trap "force_kill $server_pid" RETURN
    echo "  · waiting for rehydrate/fold-in to settle (GET /healthz ok:true, indexing:false) …"
    deadline=$(( $(date +%s) + ${COLD_BUILD_TIMEOUT:-1800} ))
    sleep 3
    until health="$(curl -fsS "http://127.0.0.1:${port}/healthz" 2>/dev/null)" \
          && [[ "$(printf '%s' "$health" | json_get ok)" == "true" ]] \
          && [[ "$(printf '%s' "$health" | json_get indexing)" != "true" ]]; do
      berr="$(printf '%s' "${health:-}" | json_get bootstrapError)"
      if [[ -n "$berr" ]]; then
        echo "error: warm bootstrap failed for base '$base': $berr" >&2
        return 1
      fi
      if (( $(date +%s) > deadline )); then
        echo "error: warm rehydrate/fold for base '$base' did not settle before COLD_BUILD_TIMEOUT." >&2
        return 1
      fi
      sleep 5
    done
    force_kill "$server_pid"
    trap - RETURN
    # Clones are on disk now — pull + hash-diff reindex (catches new commits), then export.
    echo "  · rehydrate/fold settled; scanning for new commits + exporting"
    KB_HOME="$kb_home" kb_server scan \
      --base "$base" \
      --out "$new" \
      ${REPOS_FLAG} \
      --json
  else
    # ---- Cold path: first-ever build from the base's repo --------------------
    if [[ -z "$repos" ]]; then
      echo "error: base '$base' has no repos and no existing snapshot — cannot cold-build." >&2
      return 1
    fi
    echo "  · cold path: building base from repos: $repos"
    local kb_home port server_pid deadline health
    kb_home="$WORK/$base/home"
    port="${PORT:-38117}"
    mkdir -p "$kb_home"
    KB_HOME="$kb_home" KB_BASE="$base" \
      KB_GIT_REPOS="$repos" \
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
  set +e
  ( set -euo pipefail; build_base "$name" "$repos" )
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
