#!/usr/bin/env bash
set -euo pipefail

PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
if [ -d "$PNPM_HOME/bin" ]; then
  KB_BIN="$PNPM_HOME/bin"
else
  KB_BIN="$PNPM_HOME"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_KB="$ROOT/packages/kb-client/dist/bin/kb"
SOURCE_SERVER="$ROOT/packages/kb-server/dist/bin/kb-server"

if [ ! -f "$SOURCE_KB" ]; then
  echo "Error: packages/kb-client/dist/bin/kb not found. Run 'pnpm run build' first." >&2
  exit 1
fi
if [ ! -f "$SOURCE_SERVER" ]; then
  echo "Error: packages/kb-server/dist/bin/kb-server not found. Run 'pnpm run build' first." >&2
  exit 1
fi

mkdir -p "$KB_BIN"
ln -sf "$SOURCE_KB" "$KB_BIN/kb"
ln -sf "$SOURCE_SERVER" "$KB_BIN/kb-server"
echo "Linked: $KB_BIN/kb -> $SOURCE_KB"
echo "Linked: $KB_BIN/kb-server -> $SOURCE_SERVER"

export PATH="$KB_BIN:$PATH"

shell_name="$(basename "${SHELL:-bash}")"
case "$shell_name" in
  zsh)  rc_file="$HOME/.zshrc" ;;
  bash) rc_file="$HOME/.bashrc" ;;
  *)    rc_file="$HOME/.profile" ;;
esac

path_line="export PATH=\"$KB_BIN:\$PATH\""
touch "$rc_file"
if ! grep -Fq "$KB_BIN" "$rc_file"; then
  printf '\n%s\n' "$path_line" >> "$rc_file"
  echo "Added $KB_BIN to PATH in $rc_file"
  echo "Run 'source $rc_file' or open a new shell to pick it up."
fi
