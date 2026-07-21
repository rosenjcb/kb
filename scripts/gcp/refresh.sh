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
  local base="$1" repo="$2" branch="$3"
  local prefix cur new pointer prev digest
  prefix="$(snapshot_prefix_for "$base")"
  cur="$WORK/$base/cur"
  new="$WORK/$base/new"
  rm -rf "$WORK/$base"; mkdir -p "$cur" "$new"

  echo "▶ building base=$base repo=${repo:-<none>} version=$VERSION repos_flag=${REPOS_FLAG:-<full>}"
  pointer="$(gcs_read_pointer "$prefix")"

  if [[ -n "$pointer" ]]; then
    # ---- Warm path: incremental rescan from the previous snapshot -----------
    prev="$(printf '%s' "$pointer" | json_get version)"
    echo "  · warm path: adopting previous snapshot version=$prev"
    gcs_pull_prefix "$prefix/$prev" "$cur"
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
while IFS=$'\t' read -r name repo branch _is_default; do
  [[ -z "${name:-}" ]] && continue
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
