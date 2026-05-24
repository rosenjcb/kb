---
layout: default
title: src/cli/CLI.md
date: '2026-05-24'
kb_id: src-cli-cli-md
tags:
  - original-source
  - src-cli-cli-md
  - kb
categories:
  - reference
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

## `CliOutput` abstraction

`index.ts` exports `CliOutput` (`log`, `error`, `write`). The TUI passes a capturing implementation so slash commands and init progress do not fight Ink rendering. **Invariant:** long-running work that prints incremental status must use the injected output, not raw `console.log`, when invoked from the TUI.

## Init / scan cycles (v3)

Checkpoint-resumable cycles (`InitCycle` in `init-cli.ts`):

```text
read-inputs → code-index → document-facts → import-docs → write
```

| Cycle | What happens |
|---|---|
| `read-inputs` | Collect markdown sources + crawl non-AST source snippets for prompts |
| `code-index` | Deterministic `kg_*` indexing (ts-morph + tree-sitter) **and** LLM `code-facts` pass for changed files |
| `document-facts` | Sentence-level facts from discovered markdown |
| `import-docs` | Verbatim original docs into SQLite |
| `write` | Persist docs; on scan, claim planner/mutations |

**Not separate checkpoint cycles:** `ast-facts` / `code-facts` / `fact-categories` names in older docs refer to **sub-steps inside** `code-index` or interactive extras. See [`../core/INIT.md`](../core/INIT.md) for narrative detail; trust `InitCycle` + `runKbInit` for resume boundaries.

`--stop-after <cycle>` and `--detach` pause after the named cycle. v2 checkpoint files are rejected — user must delete and re-run.

## AST vs LLM source coverage

`crawlSourceCode()` only walks extensions in `SOURCE_CODE_EXTENSIONS` (Swift, Kotlin today). Everything in `TREE_SITTER_AST_EXTENSIONS` (from `tree-sitter-indexer.ts`) is excluded — those files get symbols via `code-index`, not per-file LLM extraction.

Ts/JS/Go extensions are AST-handled via ts-morph or tree-sitter; do not re-add them to `SOURCE_CODE_EXTENSIONS` without intentional fallback.

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

## Gotchas

- **Base resolution:** Most commands flow through `base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE` (formatted by `cli-prerequisites.ts`).
- **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish`, `scan`, and `init --rescan` — CLI users must pass `--apply` explicitly.
- **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`).
