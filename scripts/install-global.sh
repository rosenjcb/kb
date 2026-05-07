#!/usr/bin/env bash
set -euo pipefail

KB_BIN="$HOME/.kb/bin"
KB_LINK="$KB_BIN/kb"
SOURCE_BIN="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/kb"

if [ ! -f "$SOURCE_BIN" ]; then
  echo "Error: dist/bin/kb not found. Run 'pnpm run build' first." >&2
  exit 1
fi

mkdir -p "$KB_BIN"
ln -sf "$SOURCE_BIN" "$KB_LINK"
echo "Linked: $KB_LINK -> $SOURCE_BIN"

SHELL_NAME="$(basename "$SHELL")"
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash) PROFILE="$HOME/.bashrc" ;;
  *)    PROFILE="" ;;
esac

PATH_LINE='export PATH="$HOME/.kb/bin:$PATH"'

if [ -n "$PROFILE" ] && ! grep -qF '.kb/bin' "$PROFILE" 2>/dev/null; then
  printf '\n# kb CLI\n%s\n' "$PATH_LINE" >> "$PROFILE"
  echo "Added ~/.kb/bin to PATH in $PROFILE"
  echo "Run 'source $PROFILE' or open a new terminal to use 'kb'."
elif [ -n "$PROFILE" ]; then
  echo "PATH already configured in $PROFILE"
else
  echo "Unknown shell ($SHELL_NAME). Add this to your shell profile manually:"
  echo "  $PATH_LINE"
fi
