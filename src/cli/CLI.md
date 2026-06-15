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
| `code-index` | Deterministic AST indexing into `facts`/`fact_edges` (ts-morph + tree-sitter) |
| `document-facts` | Sentence-level facts from discovered markdown |
| `import-docs` | Verbatim original docs into SQLite |
| `write` | Persist docs; on scan, claim planner/mutations |

**Not separate checkpoint cycles:** `ast-facts` / `code-facts` names in older docs refer to **sub-steps inside** `code-index`. See [`../core/INIT.md`](../core/INIT.md) for narrative detail; trust `InitCycle` + `runKbInit` for resume boundaries.

`--stop-after <cycle>` and `--detach` pause after the named cycle. v2 checkpoint files are rejected — user must delete and re-run.

## AST source coverage

Code facts are **AST-only**. Extensions in `TREE_SITTER_AST_EXTENSIONS` (from `tree-sitter-indexer.ts`) plus TS/JS via ts-morph are indexed during `code-index`. Everything else is text-only or ignored.

**Previously LLM-fallback (removed):** Swift (`.swift`), Kotlin (`.kt`, `.kts`) — see [`../core/INIT.md`](../core/INIT.md) §Removed LLM code-facts fallback.

## Shared retrieval

**Single path for facts retrieval:** `runQueryTruthRetrieval()` → `runIntentLoop()` → `DefaultIntentRouter` → `read_facts`.

- `kb query` and chat QUERY must both use this — no parallel router shortcuts.

## `kb query` vs chat (synthesis split)

| Path | Synthesis | Audience |
|------|-----------|----------|
| **`kb query`** | One-shot **`enrichReadDocumentsAnswerWithLLM()`** — single LLM call over capped facts (≤150 × 2000 chars). No `query_kb` tool loop. | Programmatic callers (agents, eval harvest) |
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

`kb publish notion` and `kb publish jekyll` read publishable docs from the base SQLite index and sync them to an external sink. See [`../core/publish/PUBLISH.md`](../core/publish/PUBLISH.md).

| Command | Apply flag | Notes |
|---|---|---|
| `publish jekyll [--dir <root>] [--base <name>]` | `--apply` | Wipes lane `.md` dirs, rewrites collections + graph |
| `publish notion [--base <name>] [--parent-page-id <id>]` | `--apply` | Archives section children, recreates pages; state in `.kb-publish-notion.json` |

Preview responses include `removed` / `removedPages` for docs that exist in the sink but not in SQLite.

## Git-linked bases (multi-repo)

A base tracks **one or more** git remotes; git is **required** (local-directory indexing has been removed). The index auto-updates on every query without a manual checkout.

```text
kb init --git <url[#branch]> [--git <url[#branch]> ...] [--branch <default>] [--base <name>]
```

`--git` is repeatable; each value may carry an inline `#branch`. The `--branch` flag sets the default branch for any repo that omits one (default `main`).

Each base stores a blobless clone per repo at `~/.kb/sessions/<base>/repos/<slug>/` and a `meta.json` shaped as `{ repos: [ { gitUrl, gitBranch, slug, dir, lastSyncedSha, lastSyncedAt }, … ] }`. Every fact records its origin repo in the **`git_repo`** column, and imported doc `source_ref`s are slug-prefixed so provenance survives the fold into one graph.

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

### Managing repos (`kb base`)

```text
kb base list-repos [--base <name>]
kb base add-repo <url[#branch]> [--branch <b>] [--base <name>]
kb base remove-repo <url|slug> [--base <name>]
```

- `add-repo` clones the repo, indexes it, and rebuilds the cross-repo links.
- `remove-repo` purges that repo's facts and its clone; it refuses to remove the last remaining repo.

## Gotchas

- **Base resolution:** Most commands flow through `base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE` (formatted by `cli-prerequisites.ts`).
- **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish` — CLI users must pass `--apply` explicitly. `scan` runs through `runScanCommand` (pull + re-index every repo the base tracks); it takes no `--apply`.
- **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`).
- **Upfront questions:** Interactive `kb init` (no `--base`) asks for the base name (`prompts[0]`) and at least one git URL (`prompts[1]`) before the scan. Git URLs are **required** — there is no blank-to-local option and no fact-category prompt. Both prompts are skipped when `--base` is set, when running `kb scan`, or when resuming from checkpoint. Tests asserting prompt order must follow this sequence.
