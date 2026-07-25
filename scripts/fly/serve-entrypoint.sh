#!/usr/bin/env bash
# Serving-node boot (the low-budget, always-warm 256MB machine).
#
# The serving node holds NO durable state — it is a pure function of the latest
# snapshots in object storage. On every boot (including a Fly machine restart,
# where the rootfs persists) it:
#
#   1. wipes KB_HOME so a stale index can never shadow a fresh snapshot,
#   2. imports EVERY non-default base listed in bases.json from its latest
#      immutable snapshot (`kb-server import --from …`, sha256-verified), so the
#      base registry (/v1/bases + X-KB-Base) can serve them,
#   3. warm-starts frozen on the DEFAULT base: `start --from … --bootstrap-policy
#      snapshot-only`, which verifies that snapshot's sha256 before serving and
#      never touches git or reindexes (all the heavy work already happened on the
#      builder).
#
# One kb-server process, many bases: the default base answers requests with no
# `X-KB-Base`; every other base is served lazily from its on-disk index the
# moment a request selects it. A base whose snapshot has not been published yet
# (builder still cold-building it) is skipped — the server still boots and serves
# whatever is ready.
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
# published pointer yet.
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
  s3_pull_prefix "$prefix/$version" "$dest"
  if [[ ! -f "$dest/kb-snapshot.json" ]]; then
    echo "    ! downloaded prefix for base '$base' is not a snapshot (no kb-snapshot.json)" >&2
    return 1
  fi
  printf '%s' "$version"
}

# 2. Import every NON-default base (verified) so the registry can serve it.
imported=()
skipped=()
while IFS=$'\t' read -r name _repo _branch is_default; do
  [[ -z "${name:-}" ]] && continue
  [[ "$name" == "$DEFAULT_BASE" || "$is_default" == "true" ]] && continue
  dest="$KB_HOME/incoming/$name"
  if version="$(pull_latest "$name" "$dest")"; then
    echo "  · importing base=$name version=$version"
    # --force: KB_HOME was just wiped, but be explicit. Verifies sha256 by default.
    node "$KB_SERVER_JS" import --base "$name" --from "$dest" --force
    rm -rf "$dest"
    imported+=("$name")
  else
    echo "  · skipping base=$name (no published snapshot yet)"
    skipped+=("$name")
  fi
done < <(each_base)
rm -rf "$KB_HOME/incoming" 2>/dev/null || true
echo "  · non-default bases: ${#imported[@]} imported [${imported[*]:-}] · ${#skipped[@]} pending [${skipped[*]:-}]"

# 3. Resolve + download the DEFAULT base, then warm-start frozen on it. Its
#    snapshot MUST exist — the serving node cannot boot without a default base.
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
s3_pull_prefix "$default_prefix/$version" "$SNAPSHOT_DIR"

if [[ ! -f "$SNAPSHOT_DIR/kb-snapshot.json" ]]; then
  echo "error: downloaded prefix is not a snapshot (no kb-snapshot.json)." >&2
  exit 1
fi

# Adopt the default base into KB_HOME, then free the staging copy BEFORE serving.
# `start --from` verifies sha256 too, but it does so by copying $SNAPSHOT_DIR
# into KB_HOME and then keeping the source dir around for the process lifetime
# — so a long-running server ends up holding BOTH the /snapshot staging copy
# AND the adopted base dir at once, doubling the on-disk (and, if KB_HOME sits
# on tmpfs, RAM) footprint of the snapshot. Exactly as the non-default-base
# loop above does: `import` copies /snapshot → the base dir and exits, we
# delete /snapshot, and only then does `start` serve the now-present index in
# place (no --from: server-cli ignores --from once the base already has an
# index, and snapshot-only serves it as-is). Steady-state footprint = one
# copy, not two. Mirrors scripts/gcp/serve-entrypoint.sh.
echo "  · kb-server import --base $DEFAULT_BASE --from $SNAPSHOT_DIR"
node "$KB_SERVER_JS" import --base "$DEFAULT_BASE" --from "$SNAPSHOT_DIR" --force
rm -rf "$SNAPSHOT_DIR"

echo "  · kb-server start --base $DEFAULT_BASE --bootstrap-policy $BOOTSTRAP_POLICY (serving in place)"
exec node "$KB_SERVER_JS" start --with-mcp \
  --base "$DEFAULT_BASE" \
  --bootstrap-policy "$BOOTSTRAP_POLICY"
