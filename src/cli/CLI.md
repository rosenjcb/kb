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
| `read-inputs` | Collect markdown sources under cwd |
| `code-index` | Deterministic AST indexing into `facts`/`fact_edges` (ts-morph + tree-sitter) |
| `document-facts` | Sentence-level facts from discovered markdown |
| `import-docs` | Verbatim original docs into SQLite |
| `write` | Persist docs; on scan, claim planner/mutations |

**Not separate checkpoint cycles:** `ast-facts` / `code-facts` / `fact-categories` names in older docs refer to **sub-steps inside** `code-index` or interactive extras. See [`../core/INIT.md`](../core/INIT.md) for narrative detail; trust `InitCycle` + `runKbInit` for resume boundaries.

`--stop-after <cycle>` and `--detach` pause after the named cycle. v2 checkpoint files are rejected — user must delete and re-run.

## AST source coverage

Code facts are **AST-only**. Extensions in `TREE_SITTER_AST_EXTENSIONS` (from `tree-sitter-indexer.ts`) plus TS/JS via ts-morph are indexed during `code-index`. Everything else is text-only or ignored.

**Previously LLM-fallback (removed):** Swift (`.swift`), Kotlin (`.kt`, `.kts`) — see [`../core/INIT.md`](../core/INIT.md) §Removed LLM code-facts fallback.

## Shared retrieval

**Single path for facts retrieval:** `runQueryTruthRetrieval()` → `runIntentLoop()` → `DefaultIntentRouter` → `read_facts`.

- `kb query` and chat QUERY must both use this — no parallel router shortcuts.
- Post-retrieval prose: `enrichReadDocumentsAnswerWithLLM()` in `intent-cli.ts`.

## Command reference helpers

`cmd-ref.ts` provides `cmd()`, `cmdIntro()`, `cmdHelpHint()` with `CmdMode` (`cli` vs `tui`). User-facing hints in chat should use **slash form** (`/scan`), not `kb scan`.

## Skills installer

`skill-installer.ts` bundles skills from `src/skills/loader.ts` (dev: `skills/<name>/SKILL.md`; prod: `dist/bin/<name>.skill.md`).

- **Global:** `installSkillsGlobally()` writes per-agent paths (Claude, Cursor `.mdc`, Codex, GitHub Copilot) with `<!-- kb-skill-hash: … -->` for idempotent updates.
- **Profile:** `installSkillIntoProject()` injects `kb:dev-workflow` body into `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` when present.

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

## Gotchas

- **Base resolution:** Most commands flow through `base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE` (formatted by `cli-prerequisites.ts`).
- **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish`, `scan`, and `init --rescan` — CLI users must pass `--apply` explicitly.
- **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`).
