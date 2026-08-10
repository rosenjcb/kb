<p align="center">
  <img src="assets/kb-logo.png" alt="KB Logo" width="340" />
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license" /></a>
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="node version" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quickstart-→-blue.svg" alt="quick start" /></a>
  <a href="#cli-reference"><img src="https://img.shields.io/badge/CLI-reference-orange.svg" alt="CLI reference" /></a>
</p>

<p align="center">
  <a href="https://rosenjcb.github.io/kb/"><img src="https://img.shields.io/badge/✨_Try_the_chat_demo-live-00a2ff?style=for-the-badge&labelColor=0b1220" alt="Try the chat demo" /></a>
</p>

<p align="center">
  <b>⭐ Don’t clone first — <a href="https://rosenjcb.github.io/kb/">ask the repo in the browser</a></b>.
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

Three steps: install → start the server with your repos → ask something.

### 1) Install

```bash
curl -fsSL https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh | bash
command -v kb && command -v kb-server
```

The script installs both `kb` (what you type) and `kb-server` (what does the heavy lifting) into `~/.kb/`. Open a new shell if `command -v` fails. Upgrade later with `kb sync`.

Building from a git checkout instead? See [DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md).

### 2) Start the server

The server needs an LLM API key to synthesize answers:

```bash
export GEMINI_API_KEY=<your-key>    # or OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_ENDPOINT
kb-server start --with-mcp
```

Leave that terminal running (or add `-d` to background it). It comes up on `localhost:38117` with a base named **`default`** — KB's built-in base, the way Postgres ships a `postgres` database. You never name a base just to start one. At this point `default` is **empty**: the server is up but has nothing indexed yet, and it will say so if you ask it something.

### 2b) Add your favorite repo

Point the `default` base at a repo and it starts archiving (clone → index; the first run takes a minute depending on repo size):

```bash
kb-server base add-repo --base default --git https://github.com/acme/auth-svc
```

The target base is always the explicit `--base` flag — no positional, no implicit default. Add more any time (pin a branch per repo with `<url>#branch`):

```bash
kb-server base add-repo --base default --git https://github.com/acme/web#develop
```

**Prefer to skip the empty state?** Pass the repos right at boot — same result:

```bash
kb-server start --git https://github.com/acme/auth-svc --with-mcp
```

**Want a separate, named base** (kept apart from `default`)? Create it with at least one repo, then query it with `--base`:

```bash
kb-server base create --base acme --git https://github.com/acme/auth --git https://github.com/acme/web#develop
kb-server base list          # see every base on this server
```

Base lifecycle — `create`, `add-repo`, `list`, `delete` — is an **operator** job on `kb-server`. The `kb` client can only *switch* which base it talks to (`kb base use <name>`), never create or delete one. In containers you can also declare the default base's repos with `KB_SERVER_BASE_GIT_REPOS` instead of flags. Details: [`packages/kb-core/src/core/INIT.md`](packages/kb-core/src/core/INIT.md).

### 3) Ask something

No client setup — `kb` talks to `localhost:38117` by default. Sanity-check with one question:

```bash
kb query "how does authentication work?"
```

You should get an answer plus a list of source facts. If that works, you're live.

**Try chat mode**, the thing most people stick with:

```bash
kb
```

No arguments. KB opens an interactive session (status bar shows **host** and **base**):

- **Type a question** like you would in ChatGPT: "where is the retry logic?", "summarize the init flow", "what depends on sqlite?"
- **Follow up**: context carries across turns; ask "show me the file" or "what about error handling?"
- **Slash commands**: `/help` lists everything. Useful ones early on:
  - `/query <question>`: run a structured lookup inline
  - `/facts list`: browse the curated facts for the base
  - `/graph summary`: see how modules connect
  - `/session`: review the most recent chat session and its runs
  - `/exit`: leave

The first time you run `kb`, you'll see a short welcome. If the server hasn't finished indexing yet, wait for kb-server logs to settle, then try again.

**Questions worth trying on your own repo:**

```bash
kb query "what are the main entry points?"
kb query "where is configuration loaded?"
```

kb-server re-indexes on a schedule (`KB_REINDEX_INTERVAL`), so the knowledge base tracks the remote as code changes land.

Connecting to a server someone else runs? See [Connect to a remote / team server](#connect-to-a-remote--team-server).

## Connect to a remote / team server

Most teams run **one shared kb-server** (Docker, VM, or cluster) and point every laptop and agent at it. The server owns the clones and the index; clients only talk HTTP/MCP.

Run it with an API key and a reachable URL:

```bash
docker run -d --name kb-server \
  -p 38117:38117 \
  -v kb-data:/data \
  -e KB_SERVER_API_KEY=<strong-token> \
  -e GEMINI_API_KEY=<provider-key> \
  -e KB_SERVER_BASE_GIT_REPOS=https://github.com/acme/auth \
  ghcr.io/rosenjcb/kb/kb-server:latest
```

The image starts with `--with-mcp`, so agents can reach `POST /mcp` out of the box. Give teammates a reachable URL (VPN, internal DNS, HTTPS reverse proxy) — e.g. `https://kb.acme.internal:38117` — plus the same `KB_SERVER_API_KEY`. Details: [`packages/kb-server/README.md`](packages/kb-server/README.md).

Then point any client at it with two env vars. Everything in [Quick start](#quick-start) and [Connect agents](#connect-agents-claude--cursor) works unchanged — only the address differs:

```bash
export KB_CONNECTION_STRING=kb://kb.acme.internal:38117
export KB_SERVER_API_KEY=<same-token>

kb query "how does auth work?"    # humans: CLI / TUI
kb                                # chat against the team server
```

Prefer not to export? One-shot with `kb --host https://kb.acme.internal:38117 query "…"`. Agents (Claude Code / Cursor) use the same URL over MCP — see [Connect agents](#connect-agents-claude--cursor).

**All client env vars:** `KB_HOST`, `KB_PORT`, `KB_SSLMODE`, `KB_CONNECTION_STRING`, `KB_SERVER_API_KEY`, `KB_BASE`, `KB_ACTIVE_BASE`. Full reference: [`packages/kb-client/CLIENT.md`](packages/kb-client/CLIENT.md).

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
kb --host <host:port|url>   …   # overrides KB_HOST / KB_PORT / KB_SSLMODE for this invocation
```

### Query

```
kb query "<topic>" [--base <name>] [--discovery shallow|deep] [--verbose]
```

### Other commands

```
kb base use <base>             — switch active base (omit to use the server default)
kb facts list|search|show ...
kb graph ...
kb entities ...                — inspect harvested entities and name collisions
kb logs list|show|compare ...  — browse run reports
kb session                     — most recent chat session and its runs (snoop past /clear)
kb skills [install|uninstall]  — bare `kb skills` shows install status
kb mcp install|status|uninstall   — point Claude/Cursor MCP at a local or team host
kb-server start [--with-mcp]
kb sync
```

Indexing is **server-managed**: configure repos on kb-server (`--git` or `KB_SERVER_BASE_GIT_REPOS`), not `kb init` on the client.

Chat mode (`kb` with no args): `/help` for in-session commands. Deep dive: [`packages/kb-core/src/core/CHAT.md`](packages/kb-core/src/core/CHAT.md).

### Keeping up to date

```bash
kb sync
```

## Connect agents (Claude / Cursor)

| Who | How |
|-----|-----|
| **Humans** | `kb` CLI / TUI → REST (`/v1/query`, chat) |
| **Agents** | MCP only (`kb_query` + `submit_feedback` + `get_feedback_requests`) → `POST /mcp` |

**`kb mcp install` configures MCP for:**

| Agent | File written |
|-------|----------------|
| Claude Code | `~/.claude.json` (`mcpServers.kb`) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers.kb`) |

(Codex / Gemini / Copilot are **not** wired by `mcp install`. `kb skills install` still installs the skill text / hooks where those agents look.)

> **The server must expose MCP.** Start it with `kb-server start --with-mcp` (the Docker image already does) so `POST /mcp` is live — otherwise `kb_query` won't connect. Agents always hit the server's **default base** (`base`); MCP connections don't carry a per-base selector yet.

**Team remote (typical):**

```bash
export KB_CONNECTION_STRING=kb://kb.acme.internal:38117
export KB_SERVER_API_KEY=<token>

kb skills install                                    # skill + Claude hooks
kb mcp install --host https://kb.acme.internal:38117  # or: kb mcp install (uses env)
kb mcp status
# reconnect MCP in Claude Code and/or Cursor, then code as usual
```

**Local laptop server:** same commands with `--host localhost:38117`.

After sync, reload MCP so `kb_query` appears. If the agent shells out to Grep/`kb query`, the Claude PreToolUse hook reminds it to use MCP. A second Claude hook closes the quality loop at the *end* of the session: once `kb_query` was used, it asks the agent one time — at the first `git push`, or when the session stops — to call `get_feedback_requests` and resolve what it returns via `submit_feedback` on how the answers held up.

Deep dive: [`packages/kb-server/src/SERVER.md`](packages/kb-server/src/SERVER.md) · [`packages/kb-client/src/api/CONNECTION.md`](packages/kb-client/src/api/CONNECTION.md) · [`packages/kb-core/src/skills/SKILLS.md`](packages/kb-core/src/skills/SKILLS.md).

## Bases & repos

One kb-server process serves many **bases** — like databases on a single Postgres cluster. A base is a built index over one or more repos.

- **The default base is `base`.** `kb-server start` with no `--base` builds and serves it, and clients that don't ask for a base land on it. You don't name a base to connect — you name one only to create additional ones.
- **More bases:** `kb-server start` (or `kb-server scan`) with `--base <name>` (or `KB_SERVER_BASE_NAME`), each built from its own repos.
- **Pick a base from a client:** `kb --base <name> query "…"`, or a connection string `kb --connection-string kb://<key>@<host>:<port>/<name>`. Omit it to use the server's default.
- **List what a server has:** `curl <host>/v1/bases`.

Repos and ignore paths are declared **on the server**, not in local files:

- **Repos** — `--git <url[#branch]>` flags, or `KB_SERVER_BASE_GIT_REPOS` (comma / whitespace / newline-separated, each with an optional inline `#branch`).
- **Ignore** — `KB_SERVER_IGNORE` (gitignore-style patterns).

A base must be **built before you can query it** — building is `CREATE DATABASE`, querying is `CONNECT`. Asking for a base that was never built returns `404 unknown_base`; the server never silently builds one on connect. Full reference: [`packages/kb-server/README.md`](packages/kb-server/README.md).

## Building & contributing

The [Quick start](#quick-start) above is for **using** KB. The repo itself is a pnpm monorepo; if you're fixing bugs, adding features, or running eval harnesses, you'll work from a checkout with `pnpm run test`, Docker-backed `kb-server`, and changeset-driven version bumps.

**[DEVELOPERS_GUIDE.md](DEVELOPERS_GUIDE.md)**: setup, daily scripts, local server, evaluations, spec/CI gates, and release workflow. Deeper references: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md), [`TESTING.md`](TESTING.md), [`EVALUATION.md`](EVALUATION.md).
