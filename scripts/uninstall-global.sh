#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- Global kb symlink ---
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
if [ -d "$PNPM_HOME/bin" ]; then
  KB_BIN="$PNPM_HOME/bin"
else
  KB_BIN="$PNPM_HOME"
fi

KB_LINK="$KB_BIN/kb"
if [ -L "$KB_LINK" ] || [ -f "$KB_LINK" ]; then
  rm "$KB_LINK"
  echo "Removed: $KB_LINK"
fi

# --- Build output ---
if [ -d "$ROOT_DIR/dist" ]; then
  rm -rf "$ROOT_DIR/dist"
  echo "Removed: dist/"
fi

# --- Dev repo Python venv ---
if [ -d "$ROOT_DIR/.kb-python" ]; then
  rm -rf "$ROOT_DIR/.kb-python"
  echo "Removed: $ROOT_DIR/.kb-python"
fi

# --- Global Python venv (~/.kb/.kb-python) ---
KB_HOME="${KB_INSTALL_ROOT:-$HOME/.kb}"
KB_GLOBAL_PYTHON="$KB_HOME/.kb-python"
if [ -d "$KB_GLOBAL_PYTHON" ]; then
  rm -rf "$KB_GLOBAL_PYTHON"
  echo "Removed: $KB_GLOBAL_PYTHON"
fi

# --- User data (~/.kb) ---
if [ -d "$KB_HOME" ]; then
  printf '\nFound KB user data at %s (knowledge bases, runtime, logs).\n' "$KB_HOME"
  printf 'Delete it? [y/N] '
  read -r answer
  case "$answer" in
    [Yy]*)
      rm -rf "$KB_HOME"
      echo "Removed: $KB_HOME"
      ;;
    *)
      echo "Kept: $KB_HOME"
      ;;
  esac
fi

echo "Done. Run 'pnpm install:global' to reinstall."
