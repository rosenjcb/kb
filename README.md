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

You're on a new team. The repo is huge. The README is stale. You grep for an hour and still aren't sure how auth works.

**KB** reads your git repos, pulls out what matters, and lets you **ask questions in plain English** — with answers tied to real files and facts, not vibes.

Point it at a remote once. Then ask:

```bash
kb query "how does token refresh work?"
kb query "what calls the sqlite indexer?"
```

Or just type `kb` and **chat** with your codebase like you would with a teammate who actually read everything.

## What it actually does

You give KB one or more git URLs. It clones them, reads the code and docs, and builds a searchable knowledge base — **you never write facts by hand**.

From there you have two ways in:

**One-shot questions** — `kb query "…"` from any terminal. Good for a quick lookup, a CI script, or piping into another tool.

**Chat mode** — run `kb` with no arguments. You get a full-screen session: type a question, get an answer with sources, ask follow-ups, run `/docs list` or `/graph summary` without leaving the conversation. Same brain as `kb query`, but you stay in flow.

Both modes search the same index. Answers come back **grounded** — KB shows you which facts and files it used, so you can click through instead of trusting a hallucination.

KB also keeps the index fresh: when you open a session or run a query, it pulls the latest commits from your tracked repos and re-indexes if something changed. You don't babysit it.

## Quick start

Five steps: install → start the server → connect the client → index a repo → ask something.

### 1) Install

```bash
curl -fsSL https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh | bash
command -v kb && command -v kb-server
```

The script installs both `kb` (what you type) and `kb-server` (what does the heavy lifting) into `~/.kb/`. Open a new shell if `command -v` fails. Upgrade later with `kb sync`.

Building from a git checkout instead? See [DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md).

### 2) Start the server

The server needs an LLM API key to synthesize answers. Pick one provider:

```bash
export GEMINI_API_KEY=<your-key>    # or OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_ENDPOINT
kb-server start --with-mcp
```

Leave that terminal running (or run it in the background). Default address: `localhost:38117`.

### 3) Connect the client

Tell `kb` where the server is:

```bash
export KB_HOST=localhost
export KB_PORT=38117
```

Add these to your `~/.zshrc` or `~/.bashrc` so you don't repeat them. Remote server or HTTPS? See [Connect to a remote server](#connect-to-a-remote-server) below.

### 4) Index a repo

Pick **your** project — or any public repo you want to explore:

```bash
kb init --git https://github.com/acme/auth-svc
```

KB clones the repo, scans code and markdown, and extracts facts. First run takes a minute depending on repo size. When it finishes, you have a **base** (named from the repo by default).

Multiple repos in one base:

```bash
kb init --git https://github.com/acme/auth --git https://github.com/acme/web#develop --base acme
```

Pin branches with `--branch <name>` or per-repo with `<url>#branch`. Details: [`packages/kb-core/src/core/INIT.md`](packages/kb-core/src/core/INIT.md).

### 5) Use your knowledge base

Sanity check — one question from the shell:

```bash
kb query "how does authentication work?" --limit 5
```

You should get an answer plus a list of source facts. If that works, you're live.

**Try chat mode** — the thing most people stick with:

```bash
kb
```

No arguments. KB opens an interactive session:

- **Type a question** like you would in ChatGPT — "where is the retry logic?", "summarize the init flow", "what depends on sqlite?"
- **Follow up** — context carries across turns; ask "show me the file" or "what about error handling?"
- **Slash commands** — `/help` lists everything. Useful ones early on:
  - `/query <question>` — run a structured lookup inline
  - `/docs list` — browse generated docs for the base
  - `/graph summary` — see how modules connect
  - `/scan` — force a refresh after you push new commits
  - `/exit` — leave

The first time you run `kb`, you'll see a short welcome. Run `kb init` first if you haven't indexed anything yet — chat and query both need a base with facts in it.

**Questions worth trying on your own repo:**

```bash
kb query "what are the main entry points?"
kb query "where is configuration loaded?"
kb query "recent architectural decisions" --type decision
```

When code changes on the remote, KB picks it up on the next query or session open. To force a full re-pull and re-index: `kb scan`.

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
export KB_SERVER_URL=http://your-host:38117
export KB_SERVER_API_KEY=<same token>
kb init --git https://github.com/acme/auth    # indexes on the server, not locally
kb query "how does auth work?"
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
kb init --git <url[#branch]> ...
kb scan [--base <name>]        — pull + re-index all tracked repos
kb base repo list|add|remove ...
kb facts list|search|show ...
kb graph ...
kb config get | kb config llm
kb skills install|uninstall
kb-server start [--with-mcp]
kb sync
```

Chat mode (`kb` with no args): `/help` for in-session commands. Deep dive: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md).

### Keeping up to date

```bash
kb sync
```

## Agent skills

Install skills so Claude Code, Cursor, and Codex query KB before spelunking:

```bash
kb skills install
```

[`skills/`](skills/) · [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md)

## MCP — Claude Code & Cursor

With `kb-server start --with-mcp`, register the server as an MCP tool so your editor can call `kb_query` directly. Setup: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md).

## Managing bases & repos

```bash
kb base use foo
kb base repo add <url[#branch]> [--base <name>]
kb base repo remove <url|slug> [--base <name>]
kb base ignore add "tests/, **/*.spec.ts"
```

`.kbignore` at a repo root merges with base ignore patterns at scan time.

## Building & contributing

The [Quick start](#quick-start) above is for **using** KB. The repo itself is a pnpm monorepo — if you're fixing bugs, adding features, or running eval harnesses, you'll work from a checkout with `pnpm run test`, Docker-backed `kb-server`, and changeset-driven version bumps.

**[DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md)** — setup, daily scripts, local server, evaluations, spec/CI gates, and release workflow. Deeper references: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md), [`TESTING.md`](TESTING.md), [`EVALUATION.md`](EVALUATION.md).
