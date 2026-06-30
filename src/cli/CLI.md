---
type: "Subsystem"
title: "CLI Layer"
description: "Command-line entry, argument parsing, and orchestration wiring for kb."
resource: ./src/cli
tags: [cli, commands, entrypoint]
timestamp: 2026-06-20T00:00:00Z
---

# CLI Layer

Command-line entry, argument parsing, and orchestration wiring for `kb`. Implementation files live in this directory; behavioral standards for TUI vs non-interactive output are in [`../core/TUI.md`](../core/TUI.md).

## Entry points

| Entry | File | Role |
|---|---|---|
| `kb` / `kb <command>` | `index.ts` | Dispatches subcommands; bare `kb` in a TTY delegates to `src/tui/index.tsx` |
| Init / scan | `init-cli.ts` | Multi-cycle pipeline; largest file in this package |
| Query | `intent-cli.ts` + `query-truth-retrieval.ts` | Intent envelope parsing and shared retrieval |
| Chat session | `chat-cli.ts` + `chat-query-orchestrator.ts` | REPL loop; QUERY turns call `runQueryTruthRetrieval()` |
| Skills | `skill-installer.ts` | Install bundled skills to agent homes + profile blurbs |
| Uninstall | `uninstall-cli.ts` | Consumer-facing removal of the release install layout |

## Command style convention (noun → verb)

New multi-action commands follow a **noun-then-verb** shape, like `git remote …`: the
subject (noun) comes first, the action (verb) second, with a bare noun defaulting to the
read/list action.

```text
kb base ignore            # list (bare noun = read)
kb base ignore add  …     # <noun> <verb> [args]
kb base ignore remove …
kb base ignore set  …
kb base ignore clear
```

Prefer this over flag-driven mode switches: a `--list` / `--add` flag on a verb-named command
reads awkwardly. Both the CLI dispatcher (`index.ts`) and the TUI slash registry
(`src/tui/slash-command-registry.ts`) expose the same noun/verb paths, and new command groups
must follow this shape.

## `CliOutput` abstraction

`index.ts` exports `CliOutput` (`log`, `error`, `write`). The TUI passes a capturing implementation so slash commands and init progress do not fight Ink rendering. **Invariant:** long-running work that prints incremental status must use the injected output, not raw `console.log`, when invoked from the TUI.

## Init / scan cycles (v3)

Checkpoint-resumable cycles (`InitCycle` in `init-cli.ts`):

```text
read-inputs → code-index → document-facts → import-docs → write
```

| Cycle | What happens |
|---|---|
| `read-inputs` | Collect markdown sources from each tracked repo clone |
| `code-index` | Deterministic AST indexing into `facts`/`fact_edges` (tree-sitter, all languages) |
| `document-facts` | Sentence-level facts from discovered markdown |
| `import-docs` | Verbatim original docs into SQLite |
| `write` | Persist docs; on scan, claim planner/mutations |

**Not separate checkpoint cycles:** `ast-facts` / `code-facts` names in older docs refer to **sub-steps inside** `code-index`. See [`../core/INIT.md`](../core/INIT.md) for narrative detail; trust `InitCycle` + `runKbInit` for resume boundaries.

`--stop-after <cycle>` and `--detach` pause after the named cycle. v2 checkpoint files are rejected — user must delete and re-run.

## AST source coverage

Code facts are **AST-only**. Extensions in `TREE_SITTER_AST_EXTENSIONS` (from `tree-sitter-indexer.ts`) — TS/JS included — are indexed by tree-sitter during `code-index`. Everything else is text-only or ignored.

**Previously LLM-fallback (removed):** Swift (`.swift`), Kotlin (`.kt`, `.kts`) — see [`../core/INIT.md`](../core/INIT.md) §Removed LLM code-facts fallback.

## Shared retrieval

**Single path for facts retrieval:** `runQueryTruthRetrieval()` → `runIntentLoop()` → `DefaultIntentRouter` → `read_facts`.

- `kb query` and chat QUERY must both use this — no parallel router shortcuts.

## `kb query` vs chat (synthesis split)

| Path | Synthesis | Audience |
|------|-----------|----------|
| **`kb query`** | One-shot **`enrichReadDocumentsAnswerWithLLM()`** — single LLM call over curator-filtered facts (2000 chars/fact). Plain prose; no inline fact refs. No `query_kb` tool loop. | Programmatic callers (agents, eval harvest) |
| **`kb chat`** | Multi-turn **`runChatSynthesis()`** — LLM may call `query_kb` for follow-up retrievals before answering. | Interactive TUI / REPL |

Both share retrieval; only the answer phase differs. See [`../core/QUERY_INTERNALS.md`](../core/QUERY_INTERNALS.md) and [`../core/CHAT.md`](../core/CHAT.md).

## Command reference helpers

`cmd-ref.ts` provides `cmd()`, `cmdIntro()`, `cmdHelpHint()` with `CmdMode` (`cli` vs `tui`). User-facing hints in chat should use **slash form** (`/scan`), not `kb scan`.

## Skills installer

`skill-installer.ts` bundles skills from `src/skills/loader.ts` (dev: `skills/<name>/SKILL.md`; prod: `dist/bin/<name>.skill.md`).

`kb skills install` runs `installSkillsGlobally()` + `installSkillIntoProject()` + `installHooks()` together; `kb skills uninstall` reverses all three.

- **Global:** `installSkillsGlobally()` writes per-agent paths (Claude, Cursor `.mdc`, Codex, GitHub Copilot) with `<!-- kb-skill-hash: … -->` for idempotent updates.
- **Profile:** `installSkillIntoProject()` injects `kb:dev-workflow` body into `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` when present.
- **Hooks:** `installHooks()` writes `~/.kb/hooks/kb-reminder.sh` and registers a kb-first pre-tool hook in Claude / Gemini / Codex settings when their config dirs exist.

Adding a skill: append to `SKILLS` array, add `loadSkill()` source under `skills/`, ensure build copies `.skill.md` into `dist/bin/`.

## Consumer uninstall

`kb uninstall` targets the **release install layout** (`scripts/install-release.sh`). Core logic is in `performUninstall()`, shared with the TUI `/uninstall` flow.

Removes in order: `~/.kb/bin/kb` symlink (via `lstat` so broken symlinks are caught), `~/.kb/runtime/` npm package, `~/.kb/.kb-python` Python venv, and the `PATH` entry from shell rc files. Then prompts interactively before deleting `~/.kb/` user data.

Flags:
- `--yes` — skip the user-data prompt; keep `~/.kb` intact
- `--purge` — also delete `~/.kb` without prompting (implies skipping user-data prompt)

Non-interactive callers (TUI, CI) should pass `--yes` or `--purge`; without a TTY and without a flag the command exits with an error.

Distinct from `pnpm uninstall:global` (`scripts/uninstall-global.sh`), which targets the dev symlink at `$PNPM_HOME/bin/kb` and removes `dist/` + both the repo-local and global `.kb-python` venvs. **`kb uninstall` must never touch `$PNPM_HOME` paths.**

## Publish

`kb publish notion` reads publishable docs from the base SQLite index and syncs them to an external sink. See [`../core/publish/PUBLISH.md`](../core/publish/PUBLISH.md).

| Command | Apply flag | Notes |
|---|---|---|
| `publish notion [--base <name>] [--parent-page-id <id>]` | `--apply` | Archives section children, recreates pages; state in `.kb-publish-notion.json` |

Preview responses include `removed` / `removedPages` for docs that exist in the sink but not in SQLite.

## Git-linked bases (multi-repo)

A base tracks **one or more** git remotes; git is **required** (local-directory indexing has been removed). The index auto-updates on every query without a manual checkout.

```text
kb init --git <url[#branch]> [--git <url[#branch]> ...] [--branch <default>] [--base <name>]
```

`--git` is repeatable, and the branch is resolved per target by `parseGitTarget` (`init-cli.ts`): an inline `<url>#<branch>` pins that one repo, `--branch <name>` is the fallback for any target without an inline branch, and when neither is set the clone follows the remote's own default branch. Examples: `kb init --git <url> --branch develop`, `kb init --git <url>#release-2.0`.

Each base stores a blobless clone per repo at `~/.kb/sessions/<base>/repos/<slug>/` and a `meta.json` shaped as `{ repos: [ { gitUrl, gitBranch, slug, dir, lastSyncedSha, lastSyncedAt }, … ], ignore?: string[] }`. Every fact records its origin repo in the **`git_repo`** column, and imported doc `source_ref`s are slug-prefixed so provenance survives the fold into one graph. The optional `ignore` array holds gitignore-style scan-exclusion patterns (see [Ignore patterns](#ignore-patterns-kb-base-ignore)).

> **Legacy single-repo bases** with the old `meta.json` (`{ gitUrl, gitBranch, lastSyncedSha, lastSyncedAt }`) and a `repo/` clone still load and keep working.

`maybeAutoSync()` (`auto-sync.ts`) is called in two modes: (1) **on session load** — TUI startup and `kb base use` — always pulls regardless of recency (`staleLimitMs: 0`); (2) **on every intent command** — stale-gated (default 30 min). In both modes **every** repo the base tracks is synced; new commits on any repo trigger a rescan plus a cross-repo link rebuild. A failed pull emits a warning and the session continues on the existing index. Non-git bases (no `meta.json`) are no-ops.

| File | Role |
|---|---|
| `base-meta.ts` | `readBaseMeta` / `writeBaseMeta` for `meta.json` (`repos` array) |
| `git-sync.ts` | `cloneRepo`, `pullRepo`, `getHeadSha`, `baseNameFromGitUrl` |
| `auto-sync.ts` | `maybeAutoSync` — forced pull on session load; stale-gated pull on queries; per-repo rescan + cross-repo relink on new commits |

**Invariants:**
- `meta.json` is written in `runKbInit`'s `finally` block — reflects the last completed scan even on a paused run.
- `maybeAutoSync` must never throw; git failures are swallowed and logged so the session proceeds on the current index.
- File-discovery cycles run over each repo's clone dir; the caller's shell dir is only used for checkpoint paths and the `.kb` marker.
- `kb sync` = self-upgrade (GitHub Releases). Unrelated to git-linked base sync.

### Cross-repo reconciliation

After every repo is indexed, an **integration-ingest** pass bridges the per-repo subgraphs into one connected graph by linking facts across repos on real integration signals:

- `package.json` dependencies (repo A depends on repo B's published package)
- cross-repo symbol imports
- `.env` / service references

These produce bridge `fact_edges` of types **`depends_on_repo`**, **`cross_repo_symbol`**, and **`references_repo`**. Reconciliation runs at the end of `kb init`, after `kb scan`, and after auto-sync.

### Managing repos (`kb base repo`)

```text
kb base repo list [--base <name>]
kb base repo add <url[#branch]> [--branch <b>] [--base <name>]
kb base repo remove <url|slug> [--base <name>]
```

- A bare `kb base repo` (or `… repo list`) lists the tracked repos.
- `add` clones the repo, indexes it, and rebuilds the cross-repo links.
- `remove` purges that repo's facts and its clone; it refuses to remove the last remaining repo.

### Ignore patterns (`kb base ignore`)

Gitignore-style patterns let a base skip files/dirs that are irrelevant to the knowledge base. They are stored per-base in `meta.json` (`ignore: string[]`) and respected on **init and every rescan** (`kb scan`, auto-sync, `kb base repo add`).

```text
kb base ignore [list]            # show current patterns (bare command also lists)
kb base ignore add <patterns…>   # append
kb base ignore remove <patterns…># drop
kb base ignore set <patterns…>   # replace the whole list
kb base ignore clear             # remove all
```

- Patterns may be repeated args and/or comma-separated within one arg: `kb base ignore add "tests/, **/*.spec.ts"`.
- Matching (`kb-ignore.ts`) follows `.gitignore`: trailing `/` = dir-only, leading/internal `/` anchors to the repo root, bare names match by basename at any depth, `*`/`**`/`?` globs, `!` negates, and ignoring a directory ignores its contents.
- A `.kbignore` file committed at a repo root is merged on top of the base's stored patterns at scan time — handy for repo-specific rules you want version-controlled.
- Fresh interactive `kb init` prompts for patterns once (skippable; press Enter or `/skip`) and persists them to `meta.json` — including when a repo is passed via `--git`. The prompt is skipped when `--base` already has stored patterns, in non-interactive mode, on resume, and on `kb scan`.
- Changing the list affects the **next** scan. Newly-ignored paths already indexed are pruned from the file manifest but their existing facts/docs are only fully purged by a fresh re-index — the same limitation as deleting a tracked file.

## Long-lived server (`kb server`)

Dispatch: [`../server/server-cli.ts`](../server/server-cli.ts). See [`../server/SERVER.md`](../server/SERVER.md).

```text
kb server start [--base <name>] [--port <n>] [--with-mcp]
```

| Flag | Effect |
|---|---|
| (default) | REST only — `/v1/query`, `/v1/chat`, `/healthz`, `/v1/reindex` |
| `--with-mcp` | Also serves MCP Streamable HTTP at `POST /mcp` |

**MCP clients** — server must run with `--with-mcp`. Auth header must match `KB_SERVER_API_KEY`.

```bash
export KB_SERVER_API_KEY=testkey
kb server start --with-mcp

# Claude Code
claude mcp add --transport http -s user kb http://localhost:8080/mcp \
  --header "Authorization: Bearer ${KB_SERVER_API_KEY}"

# Cursor Agent — ~/.cursor/mcp.json then:
#   "kb": { "url": "http://localhost:8080/mcp", "headers": { "Authorization": "Bearer testkey" } }
agent mcp list
agent mcp list-tools kb
```

See [`../server/SERVER.md`](../server/SERVER.md) for deploy URLs and tool list.

**Boot-build:** missing index → `kb init` / `kb scan` before listen. **pnpm:** `server:start` runs locally; `server:up` / `server:docker:*` are the Docker paths. Integration: [`../../packages/kb-server/http/HTTP.md`](../../packages/kb-server/http/HTTP.md).

## Gotchas

- **Base resolution:** Most commands flow through `base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE` (formatted by `cli-prerequisites.ts`).
- **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish` — CLI users must pass `--apply` explicitly. `scan` runs through `runScanCommand` (pull + re-index every repo the base tracks); it takes no `--apply`.
- **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`).
- **Upfront questions:** Interactive `kb init` (no `--base`) asks for the base name (`prompts[0]`), at least one git URL (`prompts[1]`), then an optional, skippable ignore-patterns prompt (`prompts[2]`) before the scan. Git URLs are **required** — there is no blank-to-local option and no fact-category prompt. The ignore prompt accepts comma-separated gitignore-style patterns and may be skipped (Enter / `/skip`). The base-name and git-URL prompts are skipped when `--base` is set, when running `kb scan`, or when resuming from checkpoint; the ignore prompt is additionally skipped when the base already has stored ignore patterns. Tests asserting prompt order must follow this sequence.

## Related docs

- Behavioral spec → [`CLI.spec.md`](CLI.spec.md)
