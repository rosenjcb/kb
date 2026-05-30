#!/usr/bin/env bash
set -euo pipefail

# pnpm v11 fatally errors on `pnpm root -g` when the global bin dir is not in
# PATH, so we derive the bin path from PNPM_HOME instead of calling pnpm.
#
# pnpm v9+  : bin lives at $PNPM_HOME/bin   (default ~/.local/share/pnpm/bin)
# pnpm v8-  : bin lives at $PNPM_HOME        (default ~/.local/share/pnpm)
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
if [ -d "$PNPM_HOME/bin" ]; then
  KB_BIN="$PNPM_HOME/bin"
else
  KB_BIN="$PNPM_HOME"
fi

SOURCE_BIN="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/kb"

if [ ! -f "$SOURCE_BIN" ]; then
  echo "Error: dist/bin/kb not found. Run 'pnpm run build' first." >&2
  exit 1
fi

mkdir -p "$KB_BIN"
ln -sf "$SOURCE_BIN" "$KB_BIN/kb"
echo "Linked: $KB_BIN/kb -> $SOURCE_BIN"

# Ensure the bin directory is in PATH for the current session.
export PATH="$KB_BIN:$PATH"

# Persist the PATH entry in the user's shell rc file.
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
