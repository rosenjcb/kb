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

All configuration lives in `~/.kb/config.json`. Set your LLM credentials and feature flags there:

```bash
kb config set llm.openaiApiKey sk-...
# or
kb config set llm.anthropicApiKey sk-ant-...
```

Provider is auto-detected from whichever key is present. To set one explicitly:

```bash
kb config set llm.provider openai
```

Feature flags (optional):

```bash
kb config set features.hybridQuery true
kb config set features.sqliteIndex true
```

### 3) Set your KB base

```bash
kb default dogfood        # save a persistent default
export KB_BASE=dogfood    # override for this shell session only
kb use --show             # show active base and config default
```

Base resolution order:
1. `KB_BASE` env var — session-scoped, cleared when the terminal closes
2. `defaultBase` in `~/.kb/config.json` — persistent default set by `kb default`

Named bases store their SQLite data under `~/.kb/sessions/<base>/`.

### 4) Start using intent commands

```bash
kb submit "Document writer now supports sqlite index sync"
kb query "sqlite index sync behavior" --limit 5
kb validate "kb default persists the active base"
kb dispute "kb use should persist across sessions" --because "kb use prints an export instruction; only kb default changes durable config"
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
kb use <base>             — print export KB_BASE=<base> for the current shell
kb use --show             — show active base and config default
kb default <base>         — save persistent default to ~/.kb/config.json
kb default --show
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply]
kb publish [options]
kb chat
```

### Notes

- `kb use <base>` does **not** write to disk — it prints `export KB_BASE=<base>` for you to run in your shell. This keeps session overrides truly session-scoped.
- `kb init` defaults to base `default` if `--base` is omitted.
- Typing `kb --help` shows the full help message.

## Optional: SQLite Hybrid Search

Enable when your knowledge corpus grows and lexical search isn't enough.

### 1) Enable native SQLite dependency (if needed)

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

### 2) Turn on indexing and hybrid query

```bash
kb config set features.sqliteIndex true
kb config set features.hybridQuery true
```

Optional tuning:

```bash
kb config set features.hybridQueryCandidates 40
kb config set features.hybridQueryAlpha 0.45
kb config set features.hybridQueryMaxMs 120
```

### 3) Verify

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
