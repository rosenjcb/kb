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

**KB** is a local-first knowledge layer for development workflows.

It reads your code and documentation, extracts structured facts, and gives you a fast, queryable knowledge base — so decisions, architecture details, and project context are always at your fingertips.

No manual fact entry. KB reads from the source.

## 🧠 What it actually does

KB turns your codebase and docs into a searchable knowledge base:

* 📥 **Index** — Parse code (AST) and markdown docs to extract facts automatically. Leading YAML frontmatter (`---` blocks) is stripped before indexing — only the body becomes searchable facts
* 🔍 **Query** — Ask questions in natural language; get grounded, source-linked answers
* 🔁 **Refresh** — Re-scan after changes to keep the knowledge base current

## 🏗️ Architecture (1.0)

KB splits like Postgres: a **daemon** plus a **client**.

| Binary | Package | Role |
|--------|---------|------|
| `kb-server` | `@kb/server` | Indexing, retrieval, LLM, HTTP/MCP |
| `kb` | `@kb/client` | CLI, TUI, HTTP client to the server |

Full map: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md) · Client: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md) · Server: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md)

## Connect the `kb` client to a server

The **`kb` CLI is a thin client**. Indexing, retrieval, and LLM calls run on **`kb-server`** — on your laptop, in Docker, or on a shared host. Install `kb` locally, point it at the server, and every command (`query`, `init`, `scan`, chat/TUI) goes over HTTP.

| What | Env var | Config key (`~/.kb/config.json`) |
|------|---------|----------------------------------|
| Full server URL (HTTPS, custom path) | `KB_SERVER_URL` | — |
| Host + port | `KBHOST`, `KBPORT` | `server.host`, `server.port` |
| API key (must match server) | `KB_SERVER_API_KEY` | `server.apiKey` |
| Default base on that server | — | `server.base`, `activeBase` |

Defaults: `localhost:38117`. Use **`KB_SERVER_URL`** when the server is HTTPS or you want one string instead of host + port.

**Local server:**

```bash
kb-server start --with-mcp
kb config set server.host localhost
kb config set server.port 38117
kb config set server.apiKey <same as KB_SERVER_API_KEY on the server>
kb query "how does auth work?"
```

**Remote server (Docker, k8s, another machine):** run `kb-server` there (see [Run KB as a server](#-run-kb-as-a-server-docker)), then on your laptop:

```bash
# env — good for shells and CI
export KB_SERVER_URL=http://kb.example.com:38117   # or https://kb.example.com
export KB_SERVER_API_KEY=<token from the container / deploy>

# or persist in ~/.kb/config.json
kb config set server.host kb.example.com
kb config set server.port 38117
kb config set server.apiKey <token>

kb query "how does auth work?"
```

The server owns the index. Bootstrap repos on the server (`KB_GIT_REPOS`, `kb-server.json`, or `kb init` through the connected client). Your client does not need a local clone of those repos.

Connection profile detail: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md).

## ⚡ Quick Start

### 1) Install KB

Default first install for users: install from GitHub Releases on a fresh machine.

```bash
curl -fsSL https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh | bash
command -v kb
```

What this does:
- installs `nvm` if needed
- installs `Node 24`
- installs the latest `kb` release into `~/.kb/runtime`
- links the stable launcher at `~/.kb/bin/kb`

Or build and install from this checkout (links **both** `kb` and `kb-server`):

```bash
pnpm install
pnpm run check
pnpm run install:global
command -v kb && command -v kb-server
```

> `install-kb.sh` bootstraps `nvm` and `Node 24` if they are missing.
> KB installs its managed runtime under `~/.kb/runtime` and exposes `~/.kb/bin/kb`.
> After the first install, use `kb sync` for upgrades.
> If you later switch Node versions, rerun `kb sync` or reinstall with the bootstrap script.

Fresh-machine behavior:
- before install, `kb` will not exist yet
- after running the release installer, open a new shell if needed and run `kb`
- if you are working on KB itself, use the source install flow below instead

### Uninstalling KB

KB splits client and server like Postgres (`psql` vs `postgres`):

| Command | Removes |
|---------|---------|
| `kb uninstall` | **Client only** — `~/.kb/bin/kb`, `runtime/client` |
| `kb-server uninstall` | **Server binary/runtime** — `~/.kb/bin/kb-server`, `runtime/server` |
| `kb-server uninstall --purge` | Server **plus all server data** under `~/.kb` (sessions, indexes, `config.json`, logs) |

```bash
kb uninstall              # client only; warns that ~/.kb data remains
kb uninstall --yes        # non-interactive client uninstall

kb-server uninstall --purge --yes   # wipe server + data; keeps kb client if installed
```

There is no `kb uninstall --purge` — configuration and knowledge bases live on the server side. Use `kb-server uninstall --purge` to delete them.

From the TUI, `/uninstall` removes the **client only** (same as `kb uninstall`).

### 2) Start the server and configure the client

**LLM keys and indexing run on the server.** See [Connect the `kb` client to a server](#connect-the-kb-client-to-a-server) for local vs remote (Docker) setup. Quick local path:

```bash
kb-server start --with-mcp
# or: pnpm run server:start   # contributors, from repo root
kb config set server.host localhost
kb config set server.port 38117
# kb config set server.apiKey <same as KB_SERVER_API_KEY on the server>
```

Provider for synthesis is configured server-side (env keys: `GEMINI_API_KEY`, `OPENAI_API_KEY`, etc.).

### 3) Initialize your KB base

Create a knowledge base from one or more git repositories. **At least one git remote is required** — KB clones each repo and keeps the base fresh for you, auto-pulling and re-indexing on new commits whenever you open a session or switch to the base, so you never run a scan by hand.

```bash
# single repo (follows the remote's default branch)
kb init --git https://github.com/acme/auth-svc

# pin a branch for every --git that has no inline #branch
kb init --git https://github.com/acme/auth-svc --branch develop

# multiple repos into one base, with a per-repo inline #branch override
kb init --git https://github.com/acme/auth --git https://github.com/acme/web#develop --base acme
```

#### Choosing a branch

`--git` is repeatable, and you can target a specific branch two ways:

| Form | Scope | Example |
|------|-------|---------|
| `--branch <name>` | Default for **all** `--git` targets that omit an inline branch | `kb init --git <url> --branch develop` |
| `<url>#<branch>` (inline) | **Per repo**, overrides `--branch` for that one | `kb init --git <url>#release-2.0` |

When neither is given, the clone follows the remote's own default branch.

Multi-repo bases fold into a single connected graph. Init and scan details: [`packages/kb-core/src/core/INIT.md`](packages/kb-core/src/core/INIT.md).

### 4) Query your knowledge base

Requires a running `kb-server` (see step 2):

```bash
kb query "sqlite index sync behavior" --limit 5
kb query "how does AST indexing work"
```

Contributors running tests or eval locally use `KB_LOCAL_MODE=true` to bypass HTTP (see [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md)).

## 📖 CLI Reference

### 🎯 KB query

```
kb query "<topic>" [--base <name>] [--limit <n>] [--type decision] [--discovery shallow|deep] [--session] [--verbose]
```

### 📂 Documents

```
kb docs list [--base <name>] [--limit <n>]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
kb docs generate "<prompt>" [--type howto|introduction|reference|decision|runbook] [--limit <n>] [--base <name>]
kb docs rename <document-id> "<new title>" [--base <name>]
kb docs delete <document-id> [--base <name>] [--force]
```

### 🛠️ Other commands

```
kb base use <base>             — switch the active base for the current session
kb base use --default <base>   — save persistent default to ~/.kb/config.json
kb base use --show             — show active base and config default
kb base delete <base>          — delete a base and all its data (prompts unless --force)
kb config get
kb config set <key> <value>
kb config unset <key>
kb init --git <url[#branch]> [--git <url[#branch]> ...] [--branch <default>] [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb scan [--base <name>]
kb base repo list [--base <name>]
kb base repo add <url[#branch]> [--branch <b>] [--base <name>]
kb base repo remove <url|slug> [--base <name>]
kb base ignore list|add|remove|set|clear [<patterns…>] [--base <name>]
kb facts list|search|show ...
kb graph ...
kb logs list|show|compare ...
kb skills install|uninstall
kb-server start [--base <name>] [--port <n>] [--with-mcp]
kb sync
kb publish <notion> [options]
```

**Publish** exports the active KB documents to Notion (wipe-and-replace; preview by default, `--apply` to execute). See [`packages/kb-core/src/core/publish/PUBLISH.md`](packages/kb-core/src/core/publish/PUBLISH.md).

**Interactive session commands** (type while in `kb`):

| Command | Effect |
|---------|--------|
| `/query` | Run a KB query inline |
| `/base`, `/docs`, `/facts`, `/graph`, `/publish`, `/sync`, `/config`, `/logs`, `/skills` | Use the same command families you get in the CLI |
| `/clear` | Wipe screen, reset fact pool and full conversation history — start fresh |
| `/exit` | Leave the session |
| `/help` | List all in-session commands |
| `/docs generate "<prompt>"` | Guided doc-draft wizard |
| `/init [args]` / `/scan [args]` | Build or refresh the KB without leaving the session |
| `/session` | Show turn-by-turn token, cost, and timing stats |

Chat retrieval uses the same orchestrator as `kb query`. Details: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md) · [`packages/kb-core/src/core/QUERY_INTERNALS.md`](packages/kb-core/src/core/QUERY_INTERNALS.md).

### 🔄 Keeping `kb` up to date

```bash
kb sync
```

`kb sync` installs the latest published `kb-client-node24.tgz` and `kb-server-node24.tgz` releases into `~/.kb/runtime/{client,server}`, refreshes `~/.kb/bin/kb` and `~/.kb/bin/kb-server`, and does not use your current project directory. It runs on KB's managed `Node 24` runtime, so your shell's Node version doesn't matter.
For a fresh machine with no supported Node runtime yet, use:

```bash
curl -fsSL https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh | bash
```

### Verify

```bash
kb query "hybrid sqlite retrieval" --limit 5
```

## 🗓️ Daily Workflow

```bash
kb query "topic"
kb scan   # pull + re-index every repo the base tracks, then rebuild cross-repo links
```

`kb scan` no longer reads the current working directory — it refreshes every git repo the base tracks and rebuilds the cross-repo graph links. Auto-sync (on session load, `kb base use`, and queries) syncs all of a base's repos the same way.

## 🤖 Agent Skills: use KB while you develop

KB ships first-party **agent skills** that teach your coding agent (Claude Code, Cursor, Codex, Copilot) to reach for `kb` first when exploring a codebase. Install them with one command:

```bash
kb skills install     # install skills, then upgrade in place when KB updates them
kb skills uninstall   # remove everything kb skills install added
```

`kb skills install` copies bundled skill files into each agent's skills directory and updates core agent readmes. Installs are idempotent — re-running upgrades changed skills in place.

Source: [`skills/`](skills/) · Detail: [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md) · CLI: [`packages/kb-client/src/cli/CLI.md`](packages/kb-client/src/cli/CLI.md).

## 🚢 Run KB as a server (Docker)

Instead of a per-machine CLI, run KB as a **central HTTP/MCP server**: index your repos
once on a durable volume and let people, apps, and agents query over HTTP. The Docker
image is deployable, not just an integration harness.

### Published image (GitHub Container Registry)

Merges to `main` publish **`kb-server`** to GHCR:

**`ghcr.io/rosenjcb/kb/kb-server`** — tags include `latest` and semver release tags.

Browse: [github.com/rosenjcb/kb/pkgs/container/kb-server](https://github.com/rosenjcb/kb/pkgs/container/kb-server)

```bash
docker pull ghcr.io/rosenjcb/kb/kb-server:latest

docker run -d --name kb-server \
  -p 38117:38117 \
  -v kb-data:/data \
  -e KB_SERVER_API_KEY=<strong-token> \
  -e GEMINI_API_KEY=<provider-key> \
  -e KB_BASE=acme \
  -e KB_GIT_REPOS=https://github.com/acme/auth \
  ghcr.io/rosenjcb/kb/kb-server:latest

curl http://localhost:38117/healthz
```

The image CMD is `kb-server start --with-mcp` (`KB_HOME=/data`, `PORT=38117`). Mount `/data`
so the index survives restarts. Full env reference:
[`packages/kb-server/README.md`](packages/kb-server/README.md).

**Client on your laptop, server in Docker:** expose port `38117`, set matching
`KB_SERVER_API_KEY`, then point local `kb` at it — see
[Connect the `kb` client to a server](#connect-the-kb-client-to-a-server).

### Build from this repo (contributors)

```bash
pnpm run server:up      # seeds .env on first run; edit it, then re-run to build + boot
pnpm run server:docker:logs
curl http://localhost:38117/healthz
```

Compose manifest, config reference, and `kb-server.json`:
**[`packages/kb-server/README.md`](packages/kb-server/README.md)**.

**Slack bot:** point a Slack workspace at the same `kb-server` daemon so people can ask
`@kb <question>` in channels. Setup details live in
[`packages/kb-server/README.md`](packages/kb-server/README.md).

## 🔌 MCP — Claude Code & Cursor Agent

Point your coding agent at a running `kb-server` over **Streamable HTTP** (`POST /mcp`). The server must be started with `--with-mcp`; REST-only mode returns 404 on `/mcp`.

```bash
export KB_SERVER_API_KEY=testkey   # server + client must match
kb-server start --with-mcp
```

### Claude Code

```bash
claude mcp add --transport http -s user kb http://localhost:38117/mcp \
  --header "Authorization: Bearer ${KB_SERVER_API_KEY}"
```

Check: `claude mcp list`. For a deployed server, swap `localhost:38117` for your host.

### Cursor Agent

Cursor reads MCP config from `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). There is no `agent mcp add` — write the config, then use the CLI to inspect:

```bash
mkdir -p ~/.cursor
cat > ~/.cursor/mcp.json <<'EOF'
{
  "mcpServers": {
    "kb": {
      "url": "http://localhost:38117/mcp",
      "headers": {
        "Authorization": "Bearer testkey"
      }
    }
  }
}
EOF

agent mcp list
agent mcp list-tools kb
```

Merge into an existing `mcp.json` if you already have other servers. Restart Cursor or reload the window if the IDE does not pick up the file immediately.

**MCP tools:** `kb_query`, `read_facts`, `search_code_symbols`, `get_code_neighbors`, `get_code_graph_summary`. Details: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md).

## 📋 Behavioral specs (spec.md)

This repo documents its own behavior with the [spec.md framework](https://github.com/rosenjcb/spec.md) — sibling `*.spec.md` files for requirements and test cases, companion docs (`TUI.md`, `INTENTS.md`, …) for architecture notes. That is a repo convention, not a KB indexing requirement.

Conventions and CI enforcement: [`TESTING.md`](TESTING.md).

## 🗄️ Swapping and deleting bases

```bash
kb base use foo            # switch the active base for this session
kb base use --default foo  # save a persistent default
kb base use --show         # show active base and config default
kb base delete bar --force # delete a base and all its data
kb scan --base foo         # pull + re-index every tracked repo, rebuild cross-repo links
kb sync                    # install the latest published GitHub release
kb && /base use foo
kb && /scan
kb && /sync
```

### Adding / removing repos

```bash
kb base repo list [--base <name>]                       # list the repos a base tracks
kb base repo add <url[#branch]> [--branch <b>] [--base <name>]   # clone, index, and link a new repo
kb base repo remove <url|slug> [--base <name>]          # purge a repo's facts + clone
```

### Ignoring paths

Skip files/dirs that aren't relevant to the knowledge base with gitignore-style patterns stored per base. `kb init` also prompts for these (skippable), and every scan respects them:

```bash
kb base ignore list [--base <name>]                     # show current patterns
kb base ignore add "tests/, **/*.spec.ts, vendor"       # append (comma-separated ok)
kb base ignore remove vendor                            # drop a pattern
kb base ignore set "docs/legacy/**"                     # replace the whole list
kb base ignore clear                                    # remove all
```

A `.kbignore` file committed at a repo root is merged on top of the base's patterns at scan time.

## 📊 Evaluation

KB ships a multi-pipeline evaluation framework for measuring answer quality and exploration efficiency. See [`EVALUATION.md`](EVALUATION.md) for the query-harvest pipeline (kb vs control agent), headline ΔS metric, and MOEL exploration-cost benchmarks.

```bash
pnpm run eval -- --suite raylib --auto-score
pnpm run moel -- --suite moel-kb
```

More reading: [`eval/EVAL.md`](eval/EVAL.md).

## 🧪 Development Commands

Monorepo map: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md).

```bash
pnpm run test
pnpm run spec:check
pnpm run type-check
pnpm run lint
pnpm run build
```

To install and uninstall a dev build globally (symlinks `kb` **and** `kb-server` into `$PNPM_HOME/bin`):

```bash
pnpm run install:global    # build then symlink kb + kb-server into $PNPM_HOME/bin
pnpm run uninstall:global  # remove symlinks, dist/; prompts before deleting ~/.kb
```

> These are dev-only scripts and are not shipped in the release package. Consumer users should use `kb uninstall` instead.
