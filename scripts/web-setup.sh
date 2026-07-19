#!/usr/bin/env bash
#
# web-setup.sh — Claude Code on the web *environment* setup script for KB.
#
# Paste the contents of this file into the "Setup script" field of your Claude
# Code on the web environment (claude.ai/code → environment settings). It runs
# as root on Ubuntu 24.04 before Claude Code launches, and its disk writes are
# cached and reused across sessions in that environment — so every cloud session
# (on *any* repo) starts with the kb client installed and wired to the shared
# kb-server MCP endpoint.
#
# What it does, in order:
#   1. Ensures a Node 24 runtime is on PATH (kb requires Node 24).
#   2. Installs the published `kb` client from GitHub Releases.
#   3. Points kb at the shared kb-server and runs `kb skills install`, which
#      writes the kb skills, the "kb_query first" PreToolUse hook, and the
#      `kb` MCP entry (mcpServers.kb → <server>/mcp) into ~/.claude*.
#
# PREREQUISITES (configured in the environment UI, not here):
#   - Network access: Custom, with "include default package managers" checked,
#     PLUS an allowed domain for your kb-server host, e.g.  kb-demo.fly.dev
#     (fly.dev is NOT in the default Trusted allowlist). Without this the MCP
#     calls to the server are blocked by the security proxy.
#   - Environment variable (optional): if the server is locked with an API key,
#     set KB_SERVER_API_KEY=<key> in the environment. Leave unset for an open
#     server (the kb-demo default).
#
# Tunables — override via environment variables set in the environment UI:
KB_SERVER_URL="${KB_SERVER_URL:-https://kb-demo.fly.dev}"   # MCP + query host
KB_REQUIRED_NODE_MAJOR="${KB_REQUIRED_NODE_MAJOR:-24}"
KB_NODE_VERSION="${KB_NODE_VERSION:-24}"                    # nvm install target
KB_INSTALL_SH_URL="${KB_INSTALL_SH_URL:-https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh}"

set -euo pipefail
export KB_SERVER_URL

log() { printf '[kb-web-setup] %s\n' "$*"; }

# --- 1. Node 24 on PATH --------------------------------------------------------
# The non-interactive shell Claude uses does not source ~/.bashrc, so we make
# `node` reachable from a standard PATH dir (/usr/local/bin) rather than relying
# on nvm's shell hook.
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt "$KB_REQUIRED_NODE_MAJOR" ]; then
  log "Node $KB_REQUIRED_NODE_MAJOR+ not found (have $(node -v 2>/dev/null || echo none)); installing via nvm."
  export NVM_DIR="/root/.nvm"
  mkdir -p "$NVM_DIR"
  # raw.githubusercontent.com is on the default Trusted allowlist.
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$KB_NODE_VERSION"
  ln -sf "$(nvm which "$KB_NODE_VERSION")" /usr/local/bin/node
  # Make npm/npx available too, next to the node binary.
  node_bin_dir="$(dirname "$(nvm which "$KB_NODE_VERSION")")"
  [ -x "$node_bin_dir/npm" ] && ln -sf "$node_bin_dir/npm" /usr/local/bin/npm || true
  [ -x "$node_bin_dir/npx" ] && ln -sf "$node_bin_dir/npx" /usr/local/bin/npx || true
fi
log "node $(node -v) at $(command -v node)"

# --- 2. Install the kb client from the latest release --------------------------
log "Installing kb client from $KB_INSTALL_SH_URL"
curl -fsSL "$KB_INSTALL_SH_URL" | bash -s -- --client-only

# install-kb.sh drops the launcher at ~/.kb/bin/kb; expose it on a standard PATH
# dir so Claude's non-interactive shell (and the MCP hook) can find it.
if [ -x /root/.kb/bin/kb ]; then
  ln -sf /root/.kb/bin/kb /usr/local/bin/kb
fi
command -v kb >/dev/null 2>&1 || { log "ERROR: kb not on PATH after install"; exit 1; }
log "kb $(kb --version 2>/dev/null || echo '?') at $(command -v kb)"

# --- 3. Wire kb to the server + install skills/hook/MCP config ------------------
# `kb skills install` writes:
#   ~/.claude/skills/kb:*/SKILL.md      (kb:dev-workflow etc.)
#   ~/.claude/settings.json             (PreToolUse "ask kb_query first" hook)
#   ~/.claude.json  mcpServers.kb  -->  $KB_SERVER_URL/mcp   (with bearer if a key is set)
# KB_SERVER_URL (and KB_SERVER_API_KEY, if set) determine the MCP endpoint + auth.
log "Installing kb skills + hook + MCP config pointed at $KB_SERVER_URL"
kb skills install

log "Done. Verify inside a session with:  kb mcp status   (kb entry should read $KB_SERVER_URL/mcp)"
