#!/usr/bin/env bash
# Builder run (the hourly, one-shot 1GB machine).
#
# This is the "spawn a big node, rescan the base + gits, publish a fresh index,
# then swap it under the little node" step — done the corruption-safe way. It
# runs to completion and exits; on a Fly *scheduled* machine (--schedule hourly
# --restart no) the machine then stops until the next tick, so the 1GB node only
# costs money for the few minutes it actually builds.
#
# Flow:
#   1. Warm path (a latest.json pointer exists): download the current snapshot
#      and run `kb-server scan --from cur --out new` — adopt → git pull +
#      hash-diffed incremental reindex of the base and its git(s) → VACUUM INTO
#      export. Cheap and incremental.
#   2. Cold path (first run, no pointer): boot `kb-server start` (auto) which
#      clones KB_GIT_REPOS and builds, wait for /healthz ok, then export.
#   3. Publish: upload the fresh snapshot to an IMMUTABLE version prefix, then
#      atomically flip latest.json (the single commit point).
#   4. Swap: health-gated rolling restart of the serving machine(s) so they
#      re-adopt the new snapshot with as little downtime as possible.
#   5. Prune old immutable versions (keep SNAPSHOT_KEEP).
#
# Nothing here ever mutates a shared or live volume, so the index cannot be
# corrupted mid-flight: readers only ever see a fully-uploaded, sha256-stamped
# version that latest.json already points at.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

require_bucket

WORK="${WORK_DIR:-/work}"
CUR="$WORK/cur"
NEW="$WORK/new"
# --no-repos makes a tiny serve-only artifact; default keeps working trees so the
# serving node has source files for identical answer fidelity to today's demo.
REPOS_FLAG="${SNAPSHOT_NO_REPOS:+--no-repos}"
VERSION="$(date -u +%Y%m%dT%H%M%SZ)"

rm -rf "$WORK"; mkdir -p "$CUR" "$NEW"
echo "▶ builder run version=$VERSION base=$KB_BASE repos_flag=${REPOS_FLAG:-<full>}"

pointer="$(s3_read_pointer)"

if [[ -n "$pointer" ]]; then
  # ---- Warm path: incremental rescan from the previous snapshot -------------
  prev="$(printf '%s' "$pointer" | json_get version)"
  echo "  · warm path: adopting previous snapshot version=$prev"
  s3_pull_prefix "$SNAPSHOT_PREFIX/$prev" "$CUR"
  # scan = adopt (--from, sha256-verified) → git pull + incremental reindex → export.
  kb_server scan \
    --base "$KB_BASE" \
    --from "$CUR" \
    --out "$NEW" \
    ${REPOS_FLAG} \
    --json
else
  # ---- Cold path: first-ever build from KB_GIT_REPOS ------------------------
  echo "  · cold path: no pointer yet — building from KB_GIT_REPOS"
  : "${KB_HOME:=$WORK/home}"; export KB_HOME
  : "${PORT:=38117}"; export PORT
  mkdir -p "$KB_HOME"
  node "$KB_SERVER_JS" start --base "$KB_BASE" --bootstrap-policy auto &
  server_pid=$!
  # shellcheck disable=SC2064
  trap "kill $server_pid 2>/dev/null || true" EXIT
  echo "  · waiting for first index (GET /healthz ok:true) …"
  deadline=$(( $(date +%s) + ${COLD_BUILD_TIMEOUT:-1800} ))
  until health="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)" \
        && [[ "$(printf '%s' "$health" | json_get ok)" == "true" ]]; do
    if (( $(date +%s) > deadline )); then
      echo "error: cold build did not become ready before COLD_BUILD_TIMEOUT." >&2
      exit 1
    fi
    sleep 5
  done
  echo "  · first index ready; exporting"
  kb_server export --base "$KB_BASE" --out "$NEW" ${REPOS_FLAG} --force
  kill "$server_pid" 2>/dev/null || true
  trap - EXIT
fi

if [[ ! -f "$NEW/kb-snapshot.json" ]]; then
  echo "error: builder produced no snapshot at $NEW." >&2
  exit 1
fi
digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.digest?.index??"")' "$NEW/kb-snapshot.json")"
echo "  · fresh snapshot ready indexDigest=${digest:0:12}…"

# ---- Publish: immutable version first, THEN atomic pointer flip -------------
echo "  · uploading immutable version → $SNAPSHOT_PREFIX/$VERSION"
s3_push_prefix "$NEW" "$SNAPSHOT_PREFIX/$VERSION"

cat > "$WORK/latest.json" <<JSON
{
  "version": "$VERSION",
  "base": "$KB_BASE",
  "indexDigest": "$digest",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "  · flipping pointer latest.json → $VERSION (commit point)"
s3_write_pointer "$WORK/latest.json"

# ---- Swap: roll the serving node onto the new snapshot ----------------------
if [[ -n "${FLY_API_TOKEN:-}" && -n "${SERVE_APP:-}" ]]; then
  echo "  · rolling serving app '$SERVE_APP' onto version=$VERSION"
  node "$SELF_DIR/roll-serving.mjs"
else
  echo "  · skipping serving roll (set FLY_API_TOKEN + SERVE_APP to enable)."
  echo "    the serving node will pick up version=$VERSION on its next restart."
fi

# ---- Prune old immutable versions -------------------------------------------
echo "  · pruning old versions (keeping newest $SNAPSHOT_KEEP)"
mapfile -t versions < <(
  _s3 ls "s3://${BUCKET_NAME}/${SNAPSHOT_PREFIX}/" \
    | awk '/PRE/ {gsub(/\//,"",$2); print $2}' \
    | sort
)
count=${#versions[@]}
if (( count > SNAPSHOT_KEEP )); then
  for v in "${versions[@]:0:count-SNAPSHOT_KEEP}"; do
    [[ "$v" == "$VERSION" ]] && continue
    echo "    - deleting $v"
    _s3 rm --recursive "s3://${BUCKET_NAME}/${SNAPSHOT_PREFIX}/$v/" >/dev/null || true
  done
fi

echo "✅ builder run complete: published $VERSION and swapped the serving node."
