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

**If you run agents:** point Claude Code or Cursor at KB (via [agent skills](#agent-skills) or MCP) and they query the index instead of re-exploring the tree every session.

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

Remote server or HTTPS? See [Connect to a remote server](#connect-to-a-remote-server) below.

### 4) Use your knowledge base

First, a sanity check. Ask one question from the shell:

```bash
kb query "how does authentication work?" --limit 5
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

## Connect to a remote server

Everything above assumes server + client on the same laptop. Common alternative: **server in Docker**, **client on your machine**.

On the server host:

```bash
docker run -d --name kb-server \
  -p 38117:38117 \
  -v kb-data:/data \
  -e KB_SERVER_API_KEY=<strong-token> \
  -e GEMINI_API_KEY=<provider-key> \
  -e KB_GIT_REPOS=https://github.com/acme/auth \
  ghcr.io/rosenjcb/kb/kb-server:latest
```

On your laptop:

```bash
kb --host your-host:38117 query "how does auth work?"
# authenticated remote:
export KB_SERVER_API_KEY=<same token>
kb --host http://your-host:38117 query "how does auth work?"
```

The server owns the clones and the index; your laptop just talks to it.

**All client env vars:** `KB_HOST`, `KB_PORT`, `KB_SERVER_URL`, `KB_SERVER_API_KEY`, `KB_BASE`, `KB_ACTIVE_BASE`. Full reference: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md).

**Docker image:** `ghcr.io/rosenjcb/kb/kb-server`; see [`packages/kb-server/README.md`](packages/kb-server/README.md).

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
kb query "<topic>" [--base <name>] [--limit <n>] [--discovery shallow|deep] [--verbose]
```

### Documents

```
kb docs list|view|generate|rename|delete ...
```

### Other commands

```
kb base use <base>             — switch active base
kb base use --default <base>   — save persistent default
kb base repo list|add|remove ...
kb facts list|search|show ...
kb graph ...
kb skills install|uninstall
kb-server start [--with-mcp]
kb sync
```

Indexing is **server-managed**: configure `KB_GIT_REPOS` on kb-server, not `kb init` on the client.

Chat mode (`kb` with no args): `/help` for in-session commands. Deep dive: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md).

### Keeping up to date

```bash
kb sync
```

## Agent skills

Install skills so Claude Code, Cursor, and Codex query KB **before** spelunking. Same answers, far fewer tokens:

```bash
kb skills install
```

[`skills/`](skills/) · [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md)

## MCP (Claude Code & Cursor)

With `kb-server start --with-mcp`, register the server as an MCP tool so your editor can call `kb_query` directly. Setup: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md).

## Managing bases & repos

Server-side repos come from `KB_GIT_REPOS`. Operators can also add repos to a base:

```bash
kb base use foo
kb base repo add <url[#branch]> [--base <name>]
kb base repo remove <url|slug> [--base <name>]
kb base ignore add "tests/, **/*.spec.ts"
```

`.kbignore` at a repo root merges with base ignore patterns at index time.

## Building & contributing

The [Quick start](#quick-start) above is for **using** KB. The repo itself is a pnpm monorepo; if you're fixing bugs, adding features, or running eval harnesses, you'll work from a checkout with `pnpm run test`, Docker-backed `kb-server`, and changeset-driven version bumps.

**[DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md)**: setup, daily scripts, local server, evaluations, spec/CI gates, and release workflow. Deeper references: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md), [`TESTING.md`](TESTING.md), [`EVALUATION.md`](EVALUATION.md).
