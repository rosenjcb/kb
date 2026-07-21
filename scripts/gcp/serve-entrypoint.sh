#!/usr/bin/env bash
# Serving-node boot (the low-budget, always-warm Cloud Run service).
#
# Holds NO durable state — a pure function of the latest snapshots in GCS. Native
# `gcloud storage`, no AWS. On every boot (including a Cloud Run revision roll) it:
#   1. wipes KB_HOME so a stale index can never shadow a fresh snapshot,
#   2. imports EVERY non-default base from its latest immutable snapshot
#      (`kb-server import --from …`, sha256-verified),
#   3. warm-starts frozen on the DEFAULT base (`start --from … --bootstrap-policy
#      snapshot-only`, sha256-verified before bind, no git, no reindex).
#
# A base whose snapshot is not published yet is skipped; the server still boots.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

: "${KB_HOME:=/data}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/snapshot}"
BOOTSTRAP_POLICY="${KB_SERVER_BOOTSTRAP_POLICY:-snapshot-only}"

require_bucket

DEFAULT_BASE="$(default_base_name)"
DEFAULT_BASE="${DEFAULT_BASE:-$KB_BASE}"

echo "▶ serving-node boot (default base=$DEFAULT_BASE, policy=$BOOTSTRAP_POLICY)"

# 1. Never let a persisted index shadow the incoming snapshots.
echo "  · clearing KB_HOME ($KB_HOME) so every base re-adopts from GCS"
mkdir -p "$KB_HOME"
find "$KB_HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

# Download a base's latest immutable snapshot into <dest>. Echoes the version on
# success; returns non-zero when the base has no published pointer yet.
pull_latest() {
  local base="$1" dest="$2" prefix pointer version
  prefix="$(snapshot_prefix_for "$base")"
  pointer="$(gcs_read_pointer "$prefix")"
  if [[ -z "$pointer" ]]; then
    return 1
  fi
  version="$(printf '%s' "$pointer" | json_get version)"
  if [[ -z "$version" ]]; then
    echo "    ! base '$base' has a pointer with no 'version' field: $pointer" >&2
    return 1
  fi
  rm -rf "$dest"
  gcs_pull_prefix "$prefix/$version" "$dest"
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

# 3. Resolve + download the DEFAULT base, then warm-start frozen on it.
default_prefix="$(snapshot_prefix_for "$DEFAULT_BASE")"
pointer="$(gcs_read_pointer "$default_prefix")"
if [[ -z "$pointer" ]]; then
  echo "error: no ${default_prefix}/latest.json in bucket '$BUCKET_NAME'." >&2
  echo "       run the builder once to seed it (scripts/gcp/refresh.sh)." >&2
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
echo "  · downloading gs://$BUCKET_NAME/$default_prefix/$version → $SNAPSHOT_DIR"
gcs_pull_prefix "$default_prefix/$version" "$SNAPSHOT_DIR"

if [[ ! -f "$SNAPSHOT_DIR/kb-snapshot.json" ]]; then
  echo "error: downloaded prefix is not a snapshot (no kb-snapshot.json)." >&2
  exit 1
fi

echo "  · kb-server start --from $SNAPSHOT_DIR --base $DEFAULT_BASE --bootstrap-policy $BOOTSTRAP_POLICY"
exec node "$KB_SERVER_JS" start --with-mcp \
  --base "$DEFAULT_BASE" \
  --from "$SNAPSHOT_DIR" \
  --bootstrap-policy "$BOOTSTRAP_POLICY"
