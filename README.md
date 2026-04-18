# KB

KB is a local-first knowledge system for AI workflows.

It gives you a CLI and runtime that can:
- store durable markdown knowledge,
- query that knowledge through intent commands,
- optionally use SQLite hybrid retrieval (FTS + vector-style ranking) for better search quality as your corpus grows.

## Generalized Use Case

Use KB when you want a repeatable way to capture, validate, dispute, and retrieve project knowledge during development.

Typical flow:
1. Record facts and decisions while you work.
2. Query prior context before making new changes.
3. Keep docs close to code and version them in Git.


## Quick Start

### 1) Install and verify

```bash
pnpm install
pnpm run check
npm run refresh:global
npm run which:kb
```

### 2) Configure `~/.kb/config.json`
Provider is auto-detected from whichever key is present. To set one explicitly:

```bash
kb config set llm.provider openai
```

### 3) Set your KB base

```bash
kb use dogfood            # switch the active base for this session
kb use --default dogfood  # save a persistent default
kb use --show             # show active base and config default
```

Base resolution order (both live in `~/.kb/config.json`):
1. `activeBase` — current working base from `kb use <base>`
2. `selectedBase` — persistent default from `kb use --default <base>` (or `kb default <base>`)

Named bases store their SQLite data under `~/.kb/sessions/<base>/`.

Prerequisites are validated separately: if no base is configured you get a **knowledge base** error; if no LLM credentials/provider are available you get an **LLM** error (never combined as either/or). Canonical copy lives in `src/cli/cli-prerequisites.ts`.

### 4) Start using intent commands

```bash
kb submit "Document writer now supports sqlite index sync"
kb query "sqlite index sync behavior" --limit 5
kb validate "kb use sets the active session base"
kb dispute "kb use should persist across sessions" --because "kb use is session-scoped while kb use --default writes the saved default"
```

## CLI Reference

### Intent commands

```
kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]
kb validate "<fact>" [--domain ops] [--output human|json]
kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]
kb query "<topic>" [--limit 5] [--type decision] [--discovery shallow|deep] [--output human|json]
kb explain "<change id|fact>" [--output human|json]
```

### Document browsing

```
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Other commands

```
kb use <base>             — switch the active base for the current session
kb use --default <base>   — save persistent default to ~/.kb/config.json
kb use --show             — show active base and config default
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply]
kb publish [options]
kb chat
```

### Notes

- `kb use <base>` writes `activeBase` to `~/.kb/config.json` so future `kb` commands keep using that base until you switch again.
- `kb use --default <base>` writes `selectedBase` to `~/.kb/config.json`.
- `kb init` defaults to base `default` if `--base` is omitted.
- Typing `kb --help` shows the full help message.

## Optional: SQLite Hybrid Search

Enable when your knowledge corpus grows and lexical search isn't enough.

### 1) Enable native SQLite dependency (if needed)

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

### 2) Verify

```bash
kb submit "SQLite hybrid search enabled for this workspace"
kb query "hybrid sqlite retrieval" --limit 5
```

If hybrid retrieval is unavailable or exceeds the latency budget, KB automatically falls back to lexical markdown query.

## Daily Workflow

```bash
kb query "topic"
kb submit "new fact" --target <doc-id>
kb validate "assumption I want to check"
```

## Agent skill: use KB while you develop

Shipped as a real Cursor-style skill (YAML frontmatter + full instructions):

- **Template:** [`examples/agent-skills/kb-dev-workflow/SKILL.md`](examples/agent-skills/kb-dev-workflow/SKILL.md)

**Install (Cursor):** copy that directory into your repo as `.cursor/skills/kb-dev-workflow/` (so the path ends in `.cursor/skills/kb-dev-workflow/SKILL.md`). Other agents: import the same markdown body into whatever “rules” or “skills” format your tool expects.

The skill is self-contained (workflow + full command shapes). The [CLI Reference](#cli-reference) section above stays the in-repo quick reference for humans.

**Roadmap:** We intend to ship a `kb` command (or installer flow) that drops or syncs this skill—and the closest equivalent hooks for each ecosystem—into supported agents automatically (for example Cursor, Claude Code, and other common coding agents), so manual copying is optional rather than required.

## Development Commands

```bash
pnpm run test
pnpm run type-check
pnpm run lint
pnpm run build
```

## Project Map

```text
src/core   — provider abstraction, intent loop, agent loop, runtime types
src/cli    — CLI entrypoint, intent command parsing, base selection, kb init
src/tools  — write/query tools, markdown + sqlite index integration
```
