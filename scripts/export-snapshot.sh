#!/usr/bin/env bash
# Produce a portable KB snapshot from a running builder container, in one command.
#
# Wraps `kb-server export` inside the container, copies the snapshot out to the
# host, and reports its size. The result is a plain directory (+ a
# kb-snapshot.json manifest) you hand to serving nodes by **mounting it as a
# volume** (or unpacking a tarball) — kb-server reads it from local disk at
# startup and never pulls it from a store itself. Transport (bucket, artifact,
# rsync, scp) is your deployment system's job.
#
# Full model: packages/kb-server/HANDOFF.md
#
# Usage:
#   scripts/export-snapshot.sh [--base <name>] [--out <dir>] [--with-repos]
#                              [--container <name>] [--force]
#
#   --base <name>        Base to export (default: the container's effective base).
#   --out <dir>          Host output directory (default: ./snapshot.kb).
#   --with-repos         Keep the repo working trees (default: --no-repos, a
#                        small serve-only artifact; repos re-clone from provenance).
#   --container <name>   Builder container (default: $KB_BUILDER_CONTAINER or kb-server).
#   --force              Overwrite a non-empty --out and re-export in place.
#   --help               Show this help.
set -euo pipefail

CONTAINER="${KB_BUILDER_CONTAINER:-kb-server}"
# How kb-server is invoked inside the image (the Docker CMD entrypoint). Override
# with $KB_SERVER_CMD if your image exposes a `kb-server` binary on PATH instead.
KB_SERVER_CMD="${KB_SERVER_CMD:-node packages/kb-server/dist/bin/kb-server.js}"
BASE=""
OUT="./snapshot.kb"
REPOS_FLAG="--no-repos"
FORCE=false

# Print the leading comment block (everything after the shebang up to the first
# non-comment line) as help text, stripping the leading "# ".
usage() { awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)        BASE="${2:?--base needs a value}"; shift 2 ;;
    --out)         OUT="${2:?--out needs a value}"; shift 2 ;;
    --with-repos)  REPOS_FLAG=""; shift ;;
    --no-repos)    REPOS_FLAG="--no-repos"; shift ;;
    --container)   CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    --force)       FORCE=true; shift ;;
    --help|-h)     usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found on PATH." >&2
  exit 1
fi
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1; then
  echo "error: builder container '$CONTAINER' is not running." >&2
  echo "       start it (e.g. \`pnpm run server:up\`) or pass --container <name>." >&2
  exit 1
fi

if [[ -e "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null || true)" && "$FORCE" != true ]]; then
  echo "error: output directory '$OUT' is not empty; pass --force to overwrite." >&2
  exit 1
fi

# Stage the snapshot inside the container, then copy it out. /tmp is writable in
# the runtime image and keeps the export off the served /data volume.
IN_CONTAINER_OUT="/tmp/kb-snapshot-export.$$"
# shellcheck disable=SC2086  # $REPOS_FLAG / $BASE_FLAG are intentionally word-split
BASE_FLAG=""
[[ -n "$BASE" ]] && BASE_FLAG="--base $BASE"

cleanup() { docker exec "$CONTAINER" rm -rf "$IN_CONTAINER_OUT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "📦 Exporting snapshot from container '$CONTAINER'${BASE:+ (base: $BASE)} …"
# shellcheck disable=SC2086
docker exec "$CONTAINER" sh -c \
  "$KB_SERVER_CMD export $BASE_FLAG --out '$IN_CONTAINER_OUT' $REPOS_FLAG --force"

echo "📥 Copying snapshot to host: $OUT"
[[ "$FORCE" == true && -e "$OUT" ]] && rm -rf "$OUT"
mkdir -p "$OUT"
# Copy the directory *contents* so $OUT holds kb-snapshot.json at its root.
docker cp "$CONTAINER:$IN_CONTAINER_OUT/." "$OUT"

SIZE="$(du -sh "$OUT" 2>/dev/null | cut -f1)"
echo "✅ Snapshot ready: $OUT (${SIZE:-unknown size})"
echo
echo "Hand it to a serving node by mounting it as a volume, then:"
echo "  kb-server start --from /mnt/kb-state           # auto: re-clones + keeps fresh"
echo "  kb-server start --from /mnt/kb-state \\"
echo "    --bootstrap-policy snapshot-only             # frozen: serve as-is, no git"
echo "(tar it first if your transport needs a single file: tar czf ${OUT##*/}.tgz -C '$OUT' .)"
