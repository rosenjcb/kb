#!/usr/bin/env bash
set -euo pipefail

PNPM_ROOT="$(pnpm root -g)"
if [ -z "$PNPM_ROOT" ]; then
  echo "Error: could not determine pnpm global root. Run 'pnpm setup' first." >&2
  exit 1
fi

KB_BIN="$(dirname "$(dirname "$(dirname "$PNPM_ROOT")")")"
KB_LINK="$KB_BIN/kb"
SOURCE_BIN="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/kb"

if [ ! -f "$SOURCE_BIN" ]; then
  echo "Error: dist/bin/kb not found. Run 'pnpm run build' first." >&2
  exit 1
fi

mkdir -p "$KB_BIN"
ln -sf "$SOURCE_BIN" "$KB_LINK"
echo "Linked: $KB_LINK -> $SOURCE_BIN"
echo "Using pnpm global bin: $KB_BIN"
