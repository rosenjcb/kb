#!/usr/bin/env bash
# Full dev install from a git checkout: deps, build, global kb + kb-server symlinks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> KB developer install"
echo "    checkout: $ROOT"

echo "==> Node $(node -v)"
node scripts/check-node-version.mjs

echo "==> pnpm install"
pnpm install

echo "==> build @kb/client + @kb/server"
pnpm run build

SOURCE_KB="$ROOT/packages/kb-client/dist/bin/kb"
SOURCE_SERVER="$ROOT/packages/kb-server/dist/bin/kb-server"

if [ ! -f "$SOURCE_KB" ]; then
  echo "Error: missing $SOURCE_KB after build." >&2
  exit 1
fi
if [ ! -f "$SOURCE_SERVER" ]; then
  echo "Error: missing $SOURCE_SERVER after build." >&2
  exit 1
fi

PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
if [ -d "$PNPM_HOME/bin" ]; then
  KB_BIN="$PNPM_HOME/bin"
else
  KB_BIN="$PNPM_HOME"
fi

mkdir -p "$KB_BIN"
ln -sf "$SOURCE_KB" "$KB_BIN/kb"
ln -sf "$SOURCE_SERVER" "$KB_BIN/kb-server"
echo "==> linked $KB_BIN/kb -> $SOURCE_KB"
echo "==> linked $KB_BIN/kb-server -> $SOURCE_SERVER"

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
  echo "==> added $KB_BIN to PATH in $rc_file"
  echo "    run: source $rc_file   (or open a new shell)"
fi

export PATH="$KB_BIN:$PATH"

echo "==> smoke check"
"$SOURCE_KB" --version >/dev/null
"$SOURCE_SERVER" --version >/dev/null

echo ""
echo "Dev environment ready."
echo "  kb --version / kb-server --version"
echo "  pnpm run server:start          # local kb-server (+ MCP)"
echo "  kb --host localhost:38117 query \"…\""
echo "  pnpm run eval -- --suite kb    # harvest eval (uses this checkout's deps + build)"
echo ""
echo "Re-run anytime: pnpm run install:global"
