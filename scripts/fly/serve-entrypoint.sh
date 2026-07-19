#!/usr/bin/env bash
# Serving-node boot (the low-budget, always-warm 256MB machine).
#
# The serving node holds NO durable state — it is a pure function of the latest
# snapshot in object storage. On every boot (including a Fly machine restart,
# where the rootfs persists) it:
#
#   1. wipes KB_HOME so a stale index can never shadow a fresh snapshot
#      (`kb-server start --from` is a deliberate no-op when an index is already
#       present — see packages/kb-server/src/server-cli.ts),
#   2. reads the atomic latest.json pointer and downloads that *immutable*
#      snapshot version,
#   3. warm-starts frozen: `start --from … --bootstrap-policy snapshot-only`,
#      which verifies the snapshot's sha256 before serving and never touches git
#      or reindexes (all the heavy work already happened on the builder).
#
# Because there is no volume and the index is sha256-verified on adopt, there is
# no path by which the served index can be torn or corrupted: a bad download
# fails the verify and the machine exits non-zero (observable) instead of
# serving garbage.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

: "${KB_HOME:=/data}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/snapshot}"
BOOTSTRAP_POLICY="${KB_SERVER_BOOTSTRAP_POLICY:-snapshot-only}"

require_bucket

echo "▶ serving-node boot (base=$KB_BASE, policy=$BOOTSTRAP_POLICY)"

# 1. Never let a persisted index shadow the incoming snapshot.
echo "  · clearing KB_HOME ($KB_HOME) so --from always re-adopts"
mkdir -p "$KB_HOME"
find "$KB_HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

# 2. Resolve the atomic pointer, then pull the immutable version prefix.
pointer="$(s3_read_pointer)"
if [[ -z "$pointer" ]]; then
  echo "error: no ${SNAPSHOT_PREFIX}/latest.json in bucket '$BUCKET_NAME'." >&2
  echo "       run the builder once to seed it (scripts/fly/refresh.sh)." >&2
  exit 1
fi
version="$(printf '%s' "$pointer" | json_get version)"
digest="$(printf '%s' "$pointer" | json_get indexDigest)"
if [[ -z "$version" ]]; then
  echo "error: latest.json has no 'version' field: $pointer" >&2
  exit 1
fi
echo "  · latest snapshot version=$version indexDigest=${digest:0:12}…"

rm -rf "$SNAPSHOT_DIR"
echo "  · downloading s3://$BUCKET_NAME/$SNAPSHOT_PREFIX/$version → $SNAPSHOT_DIR"
s3_pull_prefix "$SNAPSHOT_PREFIX/$version" "$SNAPSHOT_DIR"

if [[ ! -f "$SNAPSHOT_DIR/kb-snapshot.json" ]]; then
  echo "error: downloaded prefix is not a snapshot (no kb-snapshot.json)." >&2
  exit 1
fi

# 3. Warm-start frozen. `start --from` verifies the manifest sha256 and refuses
#    an incompatible/corrupt snapshot before it ever binds the port.
echo "  · kb-server start --from $SNAPSHOT_DIR --bootstrap-policy $BOOTSTRAP_POLICY"
exec node "$KB_SERVER_JS" start --with-mcp \
  --base "$KB_BASE" \
  --from "$SNAPSHOT_DIR" \
  --bootstrap-policy "$BOOTSTRAP_POLICY"
