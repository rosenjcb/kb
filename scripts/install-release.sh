#!/usr/bin/env bash
# Fresh install from GitHub Releases — installs kb (client) and kb-server by default.
# Use --client-only or --server-only when you need one side.
set -euo pipefail

NODE_MAJOR="24"
RELEASE_BASE="https://github.com/rosenjcb/kb/releases/latest/download"
CLIENT_TARBALL_URL="${RELEASE_BASE}/kb-client-node24.tgz"
SERVER_TARBALL_URL="${RELEASE_BASE}/kb-server-node24.tgz"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"
KB_HOME_DIR="${KB_INSTALL_ROOT:-$HOME/.kb}"
KB_CLIENT_RUNTIME="$KB_HOME_DIR/runtime/client"
KB_SERVER_RUNTIME="$KB_HOME_DIR/runtime/server"
KB_BIN_DIR="$KB_HOME_DIR/bin"
KB_BIN_LINK="$KB_BIN_DIR/kb"
KB_SERVER_BIN_LINK="$KB_BIN_DIR/kb-server"
KB_PACKAGE_BIN="$KB_CLIENT_RUNTIME/node_modules/.bin/kb"
KB_SERVER_PACKAGE_BIN="$KB_SERVER_RUNTIME/node_modules/.bin/kb-server"

INSTALL_CLIENT=true
INSTALL_SERVER=true

usage() {
  cat <<EOF
Usage: install-kb.sh [--client-only | --server-only]

  (default)       Install kb client and kb-server (recommended)
  --client-only   Install kb CLI/TUI only (remote server elsewhere)
  --server-only   Install kb-server only (headless daemon)
  --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-only)
      INSTALL_SERVER=false
      shift
      ;;
    --server-only)
      INSTALL_CLIENT=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '[kb-installer] Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$INSTALL_CLIENT" != true && "$INSTALL_SERVER" != true ]]; then
  printf '[kb-installer] Nothing to install — pick a component or use the default (both).\n' >&2
  exit 1
fi

log() {
  printf '[kb-installer] %s\n' "$1"
}

fail() {
  printf '[kb-installer] %s\n' "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

has_supported_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  local major
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  [ -n "$major" ] && [ "$major" -eq "$NODE_MAJOR" ]
}

ensure_nvm_loaded() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    return 0
  fi

  require_command curl
  log "Installing nvm into $NVM_DIR"
  curl -fsSL "$NVM_INSTALL_URL" | bash

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    fail "nvm installation completed but $NVM_DIR/nvm.sh was not found."
  fi

  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
}

ensure_node() {
  if has_supported_node; then
    log "Using existing Node $(node -v)"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    log "Found Node $(node -v), but KB requires Node $NODE_MAJOR.x."
    log "Installing Node $NODE_MAJOR via nvm (your existing Node is not affected)."
  else
    log "Node not found. Installing Node $NODE_MAJOR via nvm."
  fi

  ensure_nvm_loaded
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR" >/dev/null
  nvm use "$NODE_MAJOR" >/dev/null
  log "Node $NODE_MAJOR installed and active for this session (via nvm)."
  log "Your shell will use Node $NODE_MAJOR automatically after opening a new terminal."
}

ensure_npm() {
  require_command npm
}

ensure_kb_home() {
  mkdir -p "$KB_BIN_DIR"
  if [[ "$INSTALL_CLIENT" == true ]]; then
    mkdir -p "$KB_CLIENT_RUNTIME"
  fi
  if [[ "$INSTALL_SERVER" == true ]]; then
    mkdir -p "$KB_SERVER_RUNTIME"
  fi
  # Pre-split releases used a flat runtime/node_modules tree.
  if [ -d "$KB_HOME_DIR/runtime/node_modules" ]; then
    log "Removing legacy flat runtime layout"
    rm -rf "$KB_HOME_DIR/runtime/node_modules"
  fi
}

ensure_shell_path() {
  export PATH="$KB_BIN_DIR:$PATH"

  local shell_name rc_file path_line
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) rc_file="$HOME/.zshrc" ;;
    bash) rc_file="$HOME/.bashrc" ;;
    *) rc_file="$HOME/.profile" ;;
  esac

  path_line='export PATH="$HOME/.kb/bin:$PATH"'
  touch "$rc_file"
  if ! grep -Fq "$path_line" "$rc_file"; then
    printf '\n%s\n' "$path_line" >> "$rc_file"
    log "Added ~/.kb/bin to PATH in $rc_file"
  fi
}

install_release_package() {
  local label="$1"
  local prefix="$2"
  local url="$3"
  log "Installing kb-${label} into ${prefix} from ${url}"
  npm install --ignore-scripts --prefix "$prefix" "$url"
}

link_bin() {
  local link="$1"
  local target="$2"
  ln -sf "$target" "$link"
}

install_kb_release() {
  if [[ "$INSTALL_CLIENT" == true ]]; then
    install_release_package client "$KB_CLIENT_RUNTIME" "$CLIENT_TARBALL_URL"
    link_bin "$KB_BIN_LINK" "$KB_PACKAGE_BIN"
  fi
  if [[ "$INSTALL_SERVER" == true ]]; then
    install_release_package server "$KB_SERVER_RUNTIME" "$SERVER_TARBALL_URL"
    link_bin "$KB_SERVER_BIN_LINK" "$KB_SERVER_PACKAGE_BIN"
  fi
}

verify_install() {
  if [[ "$INSTALL_CLIENT" == true ]]; then
    if [ ! -x "$KB_PACKAGE_BIN" ]; then
      fail "Installation completed but kb was not found at $KB_PACKAGE_BIN."
    fi
    log "kb installed at $KB_BIN_LINK"
  fi
  if [[ "$INSTALL_SERVER" == true ]]; then
    if [ ! -x "$KB_SERVER_PACKAGE_BIN" ]; then
      fail "Installation completed but kb-server was not found at $KB_SERVER_PACKAGE_BIN."
    fi
    log "kb-server installed at $KB_SERVER_BIN_LINK"
  fi

  if [[ "$INSTALL_CLIENT" == true ]] && ! command -v kb >/dev/null 2>&1; then
    fail "Installation completed but 'kb' is not on PATH yet. Open a new shell and try again."
  fi
  if [[ "$INSTALL_SERVER" == true ]] && ! command -v kb-server >/dev/null 2>&1; then
    fail "Installation completed but 'kb-server' is not on PATH yet. Open a new shell and try again."
  fi

  log "Managed runtimes live under $KB_HOME_DIR/runtime/{client,server}"
  log "Use 'kb sync' for upgrades."
}

ensure_node
ensure_npm
ensure_kb_home
ensure_shell_path
install_kb_release
verify_install
