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

Claude Code, Cursor, and Codex *can* grep a huge repo and answer "how does auth work?" — if you spend the tokens. Every session starts cold; every question retraces the filesystem. On our benchmarks, a headless coding agent uses **roughly an order of magnitude more tokens** and more wall time than `kb query` on the same questions ([research paper](research/main.pdf)).

**KB** keeps a **persistent, facts-first index** of your codebases — answers in plain English, tied to real files and facts, not vibes:

- **Cheaper & faster** — pre-indexed facts instead of re-exploring the tree each time
- **Multi-repo** — one server, many git repos; follow auth (or any flow) across services, not just one checkout
- **Client/server** — developers use `kb` and chat mode; Product, QA, and leadership query the same grounded knowledge without an IDE or agent subscription
- **Spec-aligned** — ingests [spec.md](https://github.com/rosenjcb/spec.md) OKF companions and behavioral `*.spec.md` specs so intent, tests, and code stay linked

Point kb-server at your repos once. Then ask:

```bash
kb query "how does token refresh work?"
kb query "what calls the sqlite indexer?"
```

Or type `kb` and **chat** with your knowledge base like you would with a teammate who already read everything — across every repo the server indexes.

## What it actually does

**kb-server** owns indexing. Configure git repos on the server (`KB_GIT_REPOS`); it clones, scans code and docs (including OKF companions and `*.spec.md` behavioral specs), extracts facts, and re-indexes on a schedule. The **kb client** connects to that server — you never run init or scan yourself. One server can index many repos into shared bases so cross-service questions land in one place.

From there you have two ways in:

**One-shot questions** — `kb query "…"` from any terminal. Good for a quick lookup, a CI script, or piping into another tool.

**Chat mode** — run `kb` with no arguments. You get a full-screen session: type a question, get an answer with sources, ask follow-ups, run `/docs list` or `/graph summary` without leaving the conversation. Same brain as `kb query`, but you stay in flow.

Both modes search the same index. Answers come back **grounded** — KB shows you which facts and files it used, so you can click through instead of trusting a hallucination.

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

Leave that terminal running (or run it in the background). Default address: `localhost:38117`. The server clones and indexes your repos automatically — first run takes a minute depending on repo size.

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

Sanity check — one question from the shell:

```bash
kb query "how does authentication work?" --limit 5
```

You should get an answer plus a list of source facts. If that works, you're live.

**Try chat mode** — the thing most people stick with:

```bash
kb --host localhost:38117
```

No arguments. KB opens an interactive session (status bar shows **host** and **base**):

- **Type a question** like you would in ChatGPT — "where is the retry logic?", "summarize the init flow", "what depends on sqlite?"
- **Follow up** — context carries across turns; ask "show me the file" or "what about error handling?"
- **Slash commands** — `/help` lists everything. Useful ones early on:
  - `/query <question>` — run a structured lookup inline
  - `/docs list` — browse generated docs for the base
  - `/graph summary` — see how modules connect
  - `/exit` — leave

The first time you run `kb`, you'll see a short welcome. If the server hasn't finished indexing yet, wait for kb-server logs to settle, then try again.

**Questions worth trying on your own repo:**

```bash
kb query "what are the main entry points?"
kb query "where is configuration loaded?"
kb query "recent architectural decisions" --type decision
```

When code changes on the remote, kb-server re-indexes on its schedule (`KB_REINDEX_INTERVAL`). You don't babysit it.

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

Your laptop doesn't need a clone of those repos — the server owns the index.

**All client env vars:** `KB_HOST`, `KB_PORT`, `KB_SERVER_URL`, `KB_SERVER_API_KEY`, `KB_BASE`, `KB_ACTIVE_BASE`. Full reference: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md).

**Docker image:** `ghcr.io/rosenjcb/kb/kb-server` — see [`packages/kb-server/README.md`](packages/kb-server/README.md).

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
kb query "<topic>" [--base <name>] [--limit <n>] [--type decision] [--discovery shallow|deep] [--verbose]
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
kb config get | kb config llm
kb skills install|uninstall
kb-server start [--with-mcp]
kb sync
```

Indexing is **server-managed** — configure `KB_GIT_REPOS` on kb-server, not `kb init` on the client.

Chat mode (`kb` with no args): `/help` for in-session commands. Deep dive: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md).

### Keeping up to date

```bash
kb sync
```

## Agent skills

Install skills so Claude Code, Cursor, and Codex query KB **before** spelunking — same answers, far fewer tokens:

```bash
kb skills install
```

[`skills/`](skills/) · [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md)

## MCP — Claude Code & Cursor

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

The [Quick start](#quick-start) above is for **using** KB. The repo itself is a pnpm monorepo — if you're fixing bugs, adding features, or running eval harnesses, you'll work from a checkout with `pnpm run test`, Docker-backed `kb-server`, and changeset-driven version bumps.

**[DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md)** — setup, daily scripts, local server, evaluations, spec/CI gates, and release workflow. Deeper references: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md), [`TESTING.md`](TESTING.md), [`EVALUATION.md`](EVALUATION.md).
