#!/usr/bin/env bash
# Serving-node boot (the low-budget, always-warm machine).
#
# The serving node holds NO durable state — it is a pure function of the latest
# snapshots in object storage. On every boot (including a Fly machine restart,
# where the rootfs persists) it:
#
#   1. wipes KB_HOME so a stale index can never shadow a fresh snapshot,
#   2. adopts the DEFAULT base (sha256-verified) and starts listening so
#      /healthz comes up before optional bases finish downloading,
#   3. imports every NON-default base listed in bases.json (best-effort;
#      incomplete/missing snapshots are skipped),
#   4. serves frozen (`--bootstrap-policy snapshot-only`).
#
# One kb-server process, many bases: the default base answers requests with no
# `X-KB-Base`; every other base is served from its on-disk index once imported.
# A base whose snapshot has not been published yet (or whose download stays
# incomplete after retries — seen with cross-region Tigris LIST/GET) is skipped.
#
# Because there is no volume and every index is sha256-verified on adopt, there
# is no path by which a served index can be torn or corrupted: a bad download
# fails the verify and that base is skipped (or, for the default base, the
# machine exits non-zero) instead of serving garbage.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

: "${KB_HOME:=/data}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/snapshot}"
BOOTSTRAP_POLICY="${KB_SERVER_BOOTSTRAP_POLICY:-snapshot-only}"
PORT="${PORT:-38117}"

require_bucket

# The default base actually booted/served: manifest default, else KB_BASE.
DEFAULT_BASE="$(default_base_name)"
DEFAULT_BASE="${DEFAULT_BASE:-$KB_BASE}"

echo "▶ serving-node boot (default base=$DEFAULT_BASE, policy=$BOOTSTRAP_POLICY)"

# 1. Never let a persisted index shadow the incoming snapshots.
echo "  · clearing KB_HOME ($KB_HOME) so every base re-adopts from object storage"
mkdir -p "$KB_HOME"
find "$KB_HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

# Download a base's latest immutable snapshot into <dest>. Echoes the version on
# success; returns non-zero (and leaves <dest> absent) when the base has no
# published pointer yet or the download stays incomplete after retries.
pull_latest() {
  local base="$1" dest="$2" prefix pointer version
  prefix="$(snapshot_prefix_for "$base")"
  pointer="$(s3_read_pointer "$prefix")"
  if [[ -z "$pointer" ]]; then
    return 1
  fi
  version="$(printf '%s' "$pointer" | json_get version)"
  if [[ -z "$version" ]]; then
    echo "    ! base '$base' has a pointer with no 'version' field: $pointer" >&2
    return 1
  fi
  rm -rf "$dest"
  if ! s3_pull_prefix "$prefix/$version" "$dest"; then
    echo "    ! downloaded prefix for base '$base' is incomplete after retries" >&2
    rm -rf "$dest"
    return 1
  fi
  # stdout = version only (aws progress is on stderr via --no-progress/redir).
  printf '%s' "$version"
}

# 2. Default base FIRST — without it we cannot serve. Import + start before the
#    optional bases so /healthz binds in seconds instead of after ~800MB of
#    brew/kestra/… downloads (and so a flaky optional pull cannot delay the roll).
default_prefix="$(snapshot_prefix_for "$DEFAULT_BASE")"
pointer="$(s3_read_pointer "$default_prefix")"
if [[ -z "$pointer" ]]; then
  echo "error: no ${default_prefix}/latest.json in bucket '$BUCKET_NAME'." >&2
  echo "       run the builder once to seed it (scripts/fly/refresh.sh)." >&2
  exit 1
fi
version="$(printf '%s' "$pointer" | json_get version)"
digest="$(printf '%s' "$pointer" | json_get indexDigest)"
if [[ -z "$version" ]]; then
  echo "error: ${default_prefix}/latest.json has no 'version' field: $pointer" >&2
  exit 1
fi
echo "  · default base '$DEFAULT_BASE' snapshot version=$version indexDigest=${digest:0:12}…"

rm -rf "$SNAPSHOT_DIR"
echo "  · downloading s3://$BUCKET_NAME/$default_prefix/$version → $SNAPSHOT_DIR"
if ! s3_pull_prefix "$default_prefix/$version" "$SNAPSHOT_DIR"; then
  echo "error: downloaded prefix for default base '$DEFAULT_BASE' is incomplete after retries." >&2
  echo "       check region co-location (serving must share the builder/Tigris region)." >&2
  exit 1
fi

# Adopt into KB_HOME and free the staging copy BEFORE serving (one copy on disk).
echo "  · kb-server import --base $DEFAULT_BASE --from $SNAPSHOT_DIR"
node "$KB_SERVER_JS" import --base "$DEFAULT_BASE" --from "$SNAPSHOT_DIR" --force
rm -rf "$SNAPSHOT_DIR"

echo "  · kb-server start --base $DEFAULT_BASE --bootstrap-policy $BOOTSTRAP_POLICY (default ready; optional bases follow)"
node "$KB_SERVER_JS" start --with-mcp \
  --base "$DEFAULT_BASE" \
  --bootstrap-policy "$BOOTSTRAP_POLICY" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Wait until the default base is actually serving before spending time on others.
for _ in $(seq 1 90); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: kb-server exited before becoming healthy." >&2
    wait "$SERVER_PID" || true
    exit 1
  fi
  if curl -sf "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"ok":true'; then
    break
  fi
  sleep 1
done

# 3. Import every NON-default base (verified) so the registry can serve it.
#    Best-effort: the server is already healthy on the default base.
imported=()
skipped=()
while IFS=$'\t' read -r name _repo _branch is_default; do
  [[ -z "${name:-}" ]] && continue
  [[ "$name" == "$DEFAULT_BASE" || "$is_default" == "true" ]] && continue
  dest="$KB_HOME/incoming/$name"
  if version="$(pull_latest "$name" "$dest")"; then
    echo "  · importing base=$name version=$version"
    if node "$KB_SERVER_JS" import --base "$name" --from "$dest" --force; then
      imported+=("$name")
    else
      echo "  · skipping base=$name (import failed)" >&2
      skipped+=("$name")
    fi
    rm -rf "$dest"
  else
    echo "  · skipping base=$name (no complete published snapshot yet)"
    skipped+=("$name")
  fi
done < <(each_base)
rm -rf "$KB_HOME/incoming" 2>/dev/null || true
echo "  · non-default bases: ${#imported[@]} imported [${imported[*]:-}] · ${#skipped[@]} pending [${skipped[*]:-}]"

trap - EXIT INT TERM
wait "$SERVER_PID"
