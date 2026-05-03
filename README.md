
<p align="center">
  <img src="assets/kb-logo.png" alt="KB Logo" width="340" />
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license" /></a>
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="node version" /></a>
</p>

KB is a local-first knowledge layer for development workflows.

It gives you a CLI and runtime that capture what your project learns over time—so decisions, fixes, and context don’t disappear into chat history or PR threads.

Instead of re-deriving the same answers, KB lets you:

* Record decisions and facts as you work
* Query past context before making changes
* Invalidate stale facts before they mislead future work

All of it lives alongside your code, versioned in Git, and queryable like a lightweight memory system.

## What it actually does

KB turns day-to-day development into a feedback loop:

* Capture — Save facts, decisions, and discoveries as you go
* Recall — Query relevant context when you need it
* Repair — Replace or remove stale knowledge before it drifts

## Quick Start

### 1) Install and verify

```bash
pnpm install
pnpm run check
npm run refresh:global
command -v kb
```

KB expects `Node 22+` in the shell that runs `kb`.

For installed clients, the supported release path is GitHub Releases. CI builds a fresh `kb-cli-node22.tgz` package for every push to `main` right now, and you can install or upgrade it with:

```bash
npm install -g ./kb-cli-node22.tgz
```

### 2) Configure `~/.kb/config.json`
Provider is auto-detected from whichever key is present. To set one explicitly:

```bash
kb config set llm.provider openai
```

### 3) Initialize your KB base

Walk through the chat-based wizard to create your knowledge base. 

```bash
cd ~/{{YOUR_AWESOME_REPO}}
kb && /init --base dogfood
```

Refresh an existing base after README or docs changes:

```bash
kb init --base dogfood --rescan
kb init --base dogfood --rescan --apply
kb && /base use dogfood
kb && /init --rescan --apply
```

### 4) Start using KB intents

```bash
kb submit "Document writer now supports sqlite index sync"
kb query "sqlite index sync behavior" --limit 5
kb invalidate "kb use should persist across sessions" "kb base use is session-scoped; use kb base use --default to write a persistent default"
```

## CLI Reference

### KB intents

One read intent:

```
kb query "<topic>" [--limit 5] [--type decision] [--discovery shallow|deep] [--session] [--verbose] [--debug] [--output human|json]
```

Two mutation intents:

```
kb submit "<fact>" [--domain ops] [--source runbook] [--output human|json]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--dry-run]
```

### Document browsing

```
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Other commands

```
kb base use <base>             — switch the active base for the current session
kb base use --default <base>   — save persistent default to ~/.kb/config.json
kb base use --show             — show active base and config default
kb base delete <base>          — delete a base and all its data (prompts unless --force)
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb init [--base <name>] --rescan [--dry-run | --apply]
kb sync [--no-pull] [--no-build] [--no-link]
kb publish [options]
kb chat [--verbose] [--debug] [--base <name>]
```

### Keeping `kb` up to date

```bash
kb sync
```

`kb sync` does not use your current project directory. It keeps a managed clone of `https://github.com/rosenjcb/kb.git` under `~/.kb/sources/kb`, fast-forwards `main`, runs `pnpm install --frozen-lockfile`, rebuilds the CLI, and refreshes the global `kb` link. It will complain early if the current shell is not running `Node 22+`.

If you just want the supported shipped client, prefer installing the latest CI-built release package from GitHub Releases instead of using `kb sync`.

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
kb submit "new fact"
kb invalidate "old fact" "replacement fact"
```

## Agent skill: use KB while you develop


- **Found here:** [`skills/kb-dev-workflow/SKILL.md`](skills/kb-dev-workflow/SKILL.md)

The skill is self-contained (workflow + full command shapes). The [CLI Reference](#cli-reference) section above stays the in-repo quick reference for humans.

## Swapping and deleting bases

```bash
kb base use foo            # switch the active base for this session
kb base use --default foo  # save a persistent default
kb base use --show             # show active base and config default
kb base delete bar --force # delete a base and all its data
kb init --base foo --rescan        # preview KB updates from changed README-like files
kb init --base foo --rescan --apply # apply planned rescan updates
kb sync                           # update from github.com/rosenjcb/kb and relink globally
kb sync --no-pull                 # rebuild/relink the managed clone without fetching
kb && /base use foo
kb && /init --rescan --apply
kb && /sync
```

Base resolution order (both live in `~/.kb/config.json`):
1. `activeBase` — current working base from `kb base use <base>`
2. `defaultBase` — persistent default from `kb base use --default <base>` (or `kb default <base>`)

Named bases store their SQLite data under `~/.kb/sessions/<base>/`.

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
src/cli    — CLI entrypoint, KB intent parsing, base selection, kb init
src/tools  — write/query tools, markdown + sqlite index integration
```
