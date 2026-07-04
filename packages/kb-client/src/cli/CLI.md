---
type: Subsystem
title: CLI Layer
description: kb client command router, TUI wiring, and remote HTTP dispatch.
resource: ./packages/kb-client/src/cli
tags: [cli, commands, client, entrypoint]
timestamp: 2026-07-03T00:00:00Z
---

# CLI Layer (`@kb/client`)

Command-line entry and TUI orchestration for the **`kb`** binary. Domain logic (init, scan, retrieval, synthesis) lives in `@kb/core`; this package routes commands and, in the default remote path, calls `kb-server` over HTTP.

Monorepo context → [`../../CLIENT.md`](../../CLIENT.md) · [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Client vs server

| Concern | Package |
|---|---|
| `kb query`, interactive chat (TUI) | `@kb/client` → HTTP SDK → `@kb/server` |
| `kb init`, `kb scan` (today) | `@kb/client` → `@kb/core` in-process (`KB_LOCAL_MODE` or direct import) |
| Index, LLM, `KbService` | `@kb/core` on the server process |

**There is no `kb server` subcommand.** Run `kb-server start` instead.

## Entry points

| Entry | File | Role |
|---|---|---|
| `kb` / `kb <command>` | `index.ts` | Dispatches subcommands; bare `kb` in a TTY → `src/tui/index.tsx` |
| Remote query/chat | `remote-commands.ts` | `/v1/query`, `/v1/chat` when not `KB_LOCAL_MODE` |
| Init / scan | `@kb/core/ops/init-cli.ts` | Imported by router; runs in-process |
| Query (local) | `@kb/core/query/intent-cli.ts` | `KB_LOCAL_MODE=true` or vitest |
| Chat session | `chat-cli.ts` | REPL; remote or local synthesis |
| Skills | `skill-installer.ts` | Install bundled skills to agent homes |
| Uninstall | `uninstall-cli.ts` | Consumer release layout removal |

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

Checkpoint-resumable cycles (`InitCycle` in `@kb/core/ops/init-cli.ts`):

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

**Not separate checkpoint cycles:** `ast-facts` / `code-facts` names in older docs refer to sub-steps inside `code-index`.

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
| **chat** | Multi-turn **`runChatSynthesis()`** — LLM may call `query_kb` for follow-up retrievals before answering. Chat is the interactive TUI (bare `kb` on a TTY), not a `kb chat` subcommand. | Interactive TUI / REPL |

Both share retrieval via `@kb/core`; only the answer phase differs. See `@kb/core/query/chat-synthesis.ts` and `@kb/core/service/query-pipeline.ts`.

### Query synthesis output budget

`enrichReadDocumentsAnswerWithLLM()` (`intent-cli.ts`) calls the LLM with `maxTokens: INTENT_LLM_MAX_OUTPUT_TOKENS` — default **32768**, override via `KB_QUERY_MAX_OUTPUT_TOKENS`. Set `KB_INTENT_LLM_ANSWER=false` to skip synthesis entirely.

**Reasoning stream:** `index.ts` passes `onReasoning` only when `stderr.isTTY`. Eval harvest, CI, and headless agents skip the thinking display so Gemini's shared `maxOutputTokens` budget is not consumed by `includeThoughts` tokens. Interactive TUI/terminal sessions still stream reasoning as a transient progress line.

**Build/config scaffold recovery:** For build-or-config questions, a stub LLM answer (<3 legacy section keywords like `prerequisites`, `commands`) may be replaced by `buildBuildConfigScaffoldAnswer()` — deterministic evidence lines grouped under Prerequisites / Commands / Flags / Platform / Gotchas. Structured markdown answers (headings, bullets, or ≥400 chars) are **never** clobbered.

**Invariants:**
- `synthesisQuestion` (pre-graph-expansion user text) drives the synthesis prompt and scaffold checks — not the graph-expanded `payload.query`.
- Non-TTY query paths must not enable `onReasoning` unless the provider separates thinking from visible output budget.
- Eval-stored answers (`q*.json`) must reflect the full synthesized text — truncation is a provider/config bug, not an eval artifact step.

## Command reference helpers

`cmd-ref.ts` provides `cmd()`, `cmdIntro()`, `cmdHelpHint()` with `CmdMode` (`cli` vs `tui`). User-facing hints in chat should use **slash form** (`/scan`), not `kb scan`.

## Skills installer

`skill-installer.ts` bundles skills from `@kb/core/skills/loader.ts` (dev: repo `skills/<name>/SKILL.md`; prod: `dist/bin/<name>.skill.md`).

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

## kb-server (separate binary)

The HTTP/MCP daemon is **`kb-server`**, not a `kb` subcommand. See [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md) and [`../../../kb-server/README.md`](../../../kb-server/README.md).

## Gotchas

- **Base resolution:** `@kb/core/storage/base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE`.
- **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish` — CLI users must pass `--apply` explicitly. `scan` runs through `runScanCommand` (pull + re-index every repo the base tracks); it takes no `--apply`.
- **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`).
- **Upfront questions:** Interactive `kb init` (no `--base`) asks for the base name (`prompts[0]`), at least one git URL (`prompts[1]`), then an optional, skippable ignore-patterns prompt (`prompts[2]`) before the scan. Git URLs are **required** — there is no blank-to-local option and no fact-category prompt. The ignore prompt accepts comma-separated gitignore-style patterns and may be skipped (Enter / `/skip`). The base-name and git-URL prompts are skipped when `--base` is set, when running `kb scan`, or when resuming from checkpoint; the ignore prompt is additionally skipped when the base already has stored ignore patterns. Tests asserting prompt order must follow this sequence.

## Related docs

- Client package → [`../../CLIENT.md`](../../CLIENT.md)
- Architecture → [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
- Server → [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md)
- Behavioral spec → [`CLI.spec.md`](CLI.spec.md)
