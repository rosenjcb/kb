#!/usr/bin/env bash
set -euo pipefail

NODE_MAJOR="24"
RELEASE_TARBALL_URL="https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node24.tgz"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"
KB_HOME_DIR="${KB_INSTALL_ROOT:-$HOME/.kb}"
KB_RUNTIME_DIR="$KB_HOME_DIR/runtime"
KB_BIN_DIR="$KB_HOME_DIR/bin"
KB_BIN_LINK="$KB_BIN_DIR/kb"
KB_PACKAGE_BIN="$KB_RUNTIME_DIR/node_modules/.bin/kb"

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
  mkdir -p "$KB_RUNTIME_DIR" "$KB_BIN_DIR"
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

install_kb_release() {
  log "Installing KB into $KB_RUNTIME_DIR from $RELEASE_TARBALL_URL"
  # --ignore-scripts prevents tree-sitter-* grammar packages from attempting
  # native compilation.  All grammars are loaded as pre-built WASM files.
  npm install --ignore-scripts --prefix "$KB_RUNTIME_DIR" "$RELEASE_TARBALL_URL"
  ln -sf "$KB_PACKAGE_BIN" "$KB_BIN_LINK"
}

verify_install() {
  if [ ! -x "$KB_PACKAGE_BIN" ]; then
    fail "Installation completed but the expected launcher was not found at $KB_PACKAGE_BIN."
  fi

  if ! command -v kb >/dev/null 2>&1; then
    fail "Installation completed but 'kb' is not on PATH yet. Open a new shell and try again."
  fi

  log "kb installed successfully at $KB_BIN_LINK"
  log "Managed runtime lives in $KB_RUNTIME_DIR"
  log "Use 'kb sync' for upgrades."
}

ensure_node
ensure_npm
ensure_kb_home
ensure_shell_path
install_kb_release
verify_install
