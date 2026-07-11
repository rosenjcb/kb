<p align="center">
  <img src="assets/kb-logo.png" alt="KB Logo" width="340" />
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license" /></a>
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="node version" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quickstart-→-blue.svg" alt="quick start" /></a>
  <a href="#cli-reference"><img src="https://img.shields.io/badge/CLI-reference-orange.svg" alt="CLI reference" /></a>
</p>

---

Every team has the person who has read all the code. Questions route through them: a PM wants to know if exports handle timezones, QA is hunting for the retry logic before filing a bug, a new hire asks how auth works for the third time. That person answers slowly, or the asker points a coding agent at the repo and pays it to rediscover what a teammate already knew.

**KB turns that person into a server.** It answers the same questions as a coding agent for a fraction of the cost ([research paper](research/main.pdf)):

| Same questions, same repo | Headless coding agent | `kb query` |
|---|---|---|
| Tokens | 676,311 | 64,952 (**10x fewer**) |
| Wall time | 402s | 159s (**2.5x faster**) |
| Remembers anything next session | no | yes |
| Works without an IDE or agent seat | no | yes |

(A second benchmark, KB answering questions about its own repo, put the token gap at 21x.)

KB earns those numbers by doing the reading up front. **kb-server** clones your git repos, extracts facts (what exists, what calls what, why decisions were made), and keeps the index fresh on a schedule. The **kb** client asks questions against that index and gets plain-English answers pinned to real files and facts, with sources listed, so nobody has to take anything on faith.

**If you write code:** run `kb query "what calls the sqlite indexer?"` from any terminal, or type `kb` and chat: ask, follow up, pull `/graph summary`, stay in flow.

**If you don't:** you still get the whole knowledge base. Product, QA, design, and leadership chat with `kb` directly. No IDE, no checkout, no per-seat agent subscription. "Does the mobile app cache credentials?" becomes a question you ask a tool, not a ticket you file.

**If you run agents:** point Claude Code or Cursor at a **team kb-server** (often remote) via MCP — agents use `kb_query`, not the `kb` CLI. Setup: [Connect agents (Claude / Cursor)](#connect-agents-claude--cursor).

One server indexes many repos into shared bases, so "follow a login from the web app through auth-svc" is one question, not three checkouts. KB also ingests [spec.md](https://github.com/rosenjcb/spec.md) OKF companions and behavioral `*.spec.md` specs, keeping intent, tests, and code linked.

```bash
kb query "how does token refresh work?"
kb          # chat with everything the server has read
```

## Quick start

Four steps: install → start the server with repos → connect the client → ask something.

### 1) Install

```bash
curl -fsSL https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh | bash
command -v kb && command -v kb-server
```

The script installs both `kb` (what you type) and `kb-server` (what does the heavy lifting) into `~/.kb/`. Open a new shell if `command -v` fails. Upgrade later with `kb sync`.

Building from a git checkout instead? See [DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md).

### 2) Start the server

The server needs an LLM API key to synthesize answers and git repos to index:

```bash
export GEMINI_API_KEY=<your-key>    # or OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_ENDPOINT
export KB_GIT_REPOS=https://github.com/acme/auth-svc
kb-server start --with-mcp
```

Leave that terminal running (or run it in the background). Default address: `localhost:38117`. The server clones and indexes your repos automatically; the first run takes a minute depending on repo size.

Multiple repos in one base:

```bash
export KB_GIT_REPOS="https://github.com/acme/auth,https://github.com/acme/web#develop"
export KB_BASE=acme
kb-server start --with-mcp
```

Pin branches per-repo with `<url>#branch`. Details: [`packages/kb-core/src/core/INIT.md`](packages/kb-core/src/core/INIT.md).

### 3) Connect the client

Tell `kb` where the server is (once per shell, or add to your profile):

```bash
kb --host localhost:38117 query "how does auth work?"
```

Or set env vars so you can omit `--host`:

```bash
export KB_HOST=localhost
export KB_PORT=38117
```

Remote / team server? See [Connect to a remote / team server](#connect-to-a-remote--team-server) below (humans + agents).

### 4) Use your knowledge base

First, a sanity check. Ask one question from the shell:

```bash
kb query "how does authentication work?"
```

You should get an answer plus a list of source facts. If that works, you're live.

**Try chat mode**, the thing most people stick with:

```bash
kb --host localhost:38117
```

No arguments. KB opens an interactive session (status bar shows **host** and **base**):

- **Type a question** like you would in ChatGPT: "where is the retry logic?", "summarize the init flow", "what depends on sqlite?"
- **Follow up**: context carries across turns; ask "show me the file" or "what about error handling?"
- **Slash commands**: `/help` lists everything. Useful ones early on:
  - `/query <question>`: run a structured lookup inline
  - `/docs list`: browse generated docs for the base
  - `/graph summary`: see how modules connect
  - `/exit`: leave

The first time you run `kb`, you'll see a short welcome. If the server hasn't finished indexing yet, wait for kb-server logs to settle, then try again.

**Questions worth trying on your own repo:**

```bash
kb query "what are the main entry points?"
kb query "where is configuration loaded?"
```

kb-server re-indexes on a schedule (`KB_REINDEX_INTERVAL`), so the knowledge base tracks the remote as code changes land.

## Connect to a remote / team server

Most teams run **one shared kb-server** (Docker, VM, or cluster) and connect many laptops + agents to it. The server owns clones and the index; clients only talk HTTP/MCP.

### 1) Run the shared server

```bash
docker run -d --name kb-server \
  -p 38117:38117 \
  -v kb-data:/data \
  -e KB_SERVER_API_KEY=<strong-token> \
  -e GEMINI_API_KEY=<provider-key> \
  -e KB_GIT_REPOS=https://github.com/acme/auth \
  ghcr.io/rosenjcb/kb/kb-server:latest
```

Image starts with `--with-mcp`, so agents can use `POST /mcp`. Details: [`packages/kb-server/README.md`](packages/kb-server/README.md).

Give teammates a reachable URL (VPN, internal DNS, HTTPS reverse proxy, etc.) — e.g. `https://kb.acme.internal:38117` — plus the same `KB_SERVER_API_KEY`.

### 2) Humans — `kb` CLI / TUI on a laptop

```bash
export KB_SERVER_URL=https://kb.acme.internal:38117
export KB_SERVER_API_KEY=<same-token>

kb query "how does auth work?"
kb          # chat TUI against the team server
```

Or one-shot: `kb --host https://kb.acme.internal:38117 query "…"`.

### 3) Agents — Claude Code / Cursor (MCP only)

Agents must **not** use `kb query` for investigation. Point their MCP config at the **same** team URL:

```bash
export KB_SERVER_URL=https://kb.acme.internal:38117
export KB_SERVER_API_KEY=<same-token>

kb skills install
kb mcp install --host https://kb.acme.internal:38117
kb mcp status
```

That writes `mcpServers.kb` → `${url}/mcp` for **Claude Code** (`~/.claude.json`) and **Cursor** (`~/.cursor/mcp.json`) only. **Reconnect MCP** in those apps, then ask coding questions — the agent should call `kb_query` against the team node.

Switch nodes anytime: `kb mcp install --host <other-url>` (or `kb --host <other-url> skills install`) and reconnect. With no host set, install defaults to `localhost:38117` — the same default as the CLI/TUI.

**All client env vars:** `KB_HOST`, `KB_PORT`, `KB_SERVER_URL`, `KB_SERVER_API_KEY`, `KB_BASE`, `KB_ACTIVE_BASE`. Full reference: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md).

### Build once, serve cheap

The expensive work is the **initial build** (clone + scan + index + facts + embeddings). Do it once on a high-memory builder, snapshot the result, and warm-start any number of small, request-only serving nodes from it — each skips the heavy build. A snapshot is a plain directory (+ a manifest); you place it on the node as a **mounted volume or local path** and the server reads it from disk — it never pulls from a store itself. One command to produce a serve-only artifact:

```bash
scripts/export-snapshot.sh --base acme --out ./acme.kb   # from a running builder container
```

The full, host-agnostic model (works on any VM, container platform, or orchestrator): [`packages/kb-server/HANDOFF.md`](packages/kb-server/HANDOFF.md).

## Uninstalling

| Command | Removes |
|---------|---------|
| `kb uninstall` | Client only |
| `kb-server uninstall` | Server binary |
| `kb-server uninstall --purge` | Server **plus** all data under `~/.kb` |

```bash
kb uninstall --yes
kb-server uninstall --purge --yes
```

## CLI reference

Global flag (any command):

```
kb --host <host:port|url>   …   # overrides KB_HOST / KB_SERVER_URL for this invocation
```

### Query

```
kb query "<topic>" [--base <name>] [--discovery shallow|deep] [--verbose]
```

### Documents

```
kb docs list|view|generate|rename|delete ...
```

### Other commands

```
kb base use <base>             — switch active base
kb base use --default <base>   — save persistent default
kb facts list|search|show ...
kb graph ...
kb skills install|uninstall
kb mcp install|status|uninstall   — point Claude/Cursor MCP at a local or team host
kb-server start [--with-mcp]
kb sync
```

Indexing is **server-managed**: configure `KB_GIT_REPOS` on kb-server, not `kb init` on the client.

Chat mode (`kb` with no args): `/help` for in-session commands. Deep dive: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md).

### Keeping up to date

```bash
kb sync
```

## Connect agents (Claude / Cursor)

| Who | How |
|-----|-----|
| **Humans** | `kb` CLI / TUI → REST (`/v1/query`, chat) |
| **Agents** | MCP only (`kb_query`, …) → `POST /mcp` |

**`kb mcp install` configures MCP for:**

| Agent | File written |
|-------|----------------|
| Claude Code | `~/.claude.json` (`mcpServers.kb`) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers.kb`) |

(Codex / Gemini / Copilot are **not** wired by `mcp install`. `kb skills install` still installs the skill text / hooks where those agents look.)

**Team remote (typical):**

```bash
export KB_SERVER_URL=https://kb.acme.internal:38117
export KB_SERVER_API_KEY=<token>

kb skills install                                    # skill + Claude hooks
kb mcp install --host https://kb.acme.internal:38117  # or: kb mcp install (uses env)
kb mcp status
# reconnect MCP in Claude Code and/or Cursor, then code as usual
```

**Local laptop server:** same commands with `--host localhost:38117`.

After sync, reload MCP so `kb_query` appears. If the agent shells out to Grep/`kb query`, the Claude PreToolUse hook reminds it to use MCP.

Deep dive: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md) · [`packages/kb-client/src/api/CONNECTION.md`](packages/kb-client/src/api/CONNECTION.md) · [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md).

## Managing bases & repos

The repos a base indexes and the paths it skips are declared on the server through
environment variables — `KB_SERVER_BASE_GIT_REPOS` (repos, each with an optional inline
`#branch`) and `KB_SERVER_IGNORE` (gitignore-style ignore patterns) — not through local
files. See [`packages/kb-server/README.md`](packages/kb-server/README.md).

## Building & contributing

The [Quick start](#quick-start) above is for **using** KB. The repo itself is a pnpm monorepo; if you're fixing bugs, adding features, or running eval harnesses, you'll work from a checkout with `pnpm run test`, Docker-backed `kb-server`, and changeset-driven version bumps.

**[DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md)**: setup, daily scripts, local server, evaluations, spec/CI gates, and release workflow. Deeper references: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md), [`TESTING.md`](TESTING.md), [`EVALUATION.md`](EVALUATION.md).
