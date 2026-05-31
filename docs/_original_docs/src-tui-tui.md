---
layout: default
title: src/tui/TUI.md
date: '2026-05-30'
kb_id: src-tui-tui-md
tags:
  - original-source
  - src-tui-tui-md
  - kb
categories:
  - reference
---

# TUI Implementation (Ink)

React/Ink chat shell launched when the user runs bare `kb` in a TTY. Product-wide output tiers and slash-command contract: [`../core/TUI.md`](../core/TUI.md).

## Layout

| Component | File | Role |
|---|---|---|
| Root | `App.tsx` | Input routing, history, init/scan progress slot, slash interception |
| History | `components/HistoryPane.tsx` | `<Static>` for meta lines; scrollable transcript |
| Input | `components/InputBar.tsx` | Prompt + slash suggestions |
| Init status | `components/InitProgressBar.tsx` + `init-status.ts` | Dedicated live row for `/init` and `/scan` |
| Status bar | `components/StatusBar.tsx` | Base name, mode hints |
| Runner | `runner.ts` | Spawn `kb <args>` subprocess for output-only commands |
| Base refresh | `base-refresh.ts` | `awaitRefreshThenStart` — sequences async base resolution before session start |

## Slash command routing

[`slash-command-registry.ts`](slash-command-registry.ts) is the single source of truth for autocomplete and command metadata. [`slash-commands.ts`](slash-commands.ts) exposes resolver helpers; `App.tsx` decides routing:

- **Output-only** (`query`, `facts`, `graph`, `docs list`, `base`, `config`, …): `runCommandForTui` → stdout partitioned via `partition-shell-output.ts` → transcript entries. No LLM loop.
- **Interactive** (`/init`, `/scan`, `/docs generate`): stay on chat input surface; progress uses `InitProgressBar`, not history spam.
- **Chat turns** (no leading `/`): `runChatSession` with `ChatIO` adapter classifying each line (`chat-io-classify.ts`).

`App.tsx` tracks `slashContext` from `ChatIO.read(..., { slashContext })` and `InitQuestionIO.askQuestion(..., { slashContext })` so contextual commands (`/accept`, `/skip`, …) autocomplete without per-flow suggestion logic.

`normalizeSlashCommandArgs` strips redundant leading `/` on first token so `kb` argv matches CLI parsing.

## Extension checklist

1. Add one `SlashCommandSpec` row to [`slash-command-registry.ts`](slash-command-registry.ts) (`path`, `description`, `contexts`).
2. If output-only: add to `isOutputOnlyCommand()` in `App.tsx` and ensure CLI supports the same argv shape.
3. If confirmation-required (destructive, multi-step): handle inline in `App.tsx` **before** the `isOutputOnlyCommand` block using `setPendingConfirm`. Chain a second `setPendingConfirm` from inside `onConfirm` for two-step flows (e.g. `/uninstall`: first removes binary/runtime/Python, second offers to purge `~/.kb`). Do not route through `runCommandForTui` for flows that need TTY prompts — call the exported logic function directly.
4. If interactive with contextual slash commands: pass `slashContext` on `ChatIO.read()` or `InitQuestionIO.askQuestion()` — do not add suggestion logic in the flow.
5. Respect three output tiers from `../core/TUI.md`.
6. User-facing success copy: slash form via `cmd('…', 'tui')`.

## `ChatIO` bridge

`App.tsx` implements `ChatIO` for `chat-cli.ts`:

- `write()` → classify line → meta (`chat-meta`), loading spinner state, or assistant content
- Meta lines (`retrieval>`, `evidence>`, …) go to `<Static>` immediately — **never** held in loading accumulator

`chat-read-kind.ts` decides whether a user message starts a pending read vs immediate shell dispatch.

## Init / scan from TUI

`/init` and `/scan` call `runKbInit` / `parseScanCommand` directly with:

- `InitProgressReporter` wired to `InitProgressBar`
- `CliOutput` capture where needed
- `resolveApplyArgs()` adding `--apply` for rescan/scan

**Invariant:** init progress strings match `init-status.ts` parsing (`[init]`, `[scan]` prefixes) so the bar can parse `6/6 ast-facts …` style lines without polluting `HistoryPane`.

**Invariant:** after `/init` or `/scan` completes, `awaitRefreshThenStart(refreshBase, startChatSession)` must be used — not bare `refreshBase(); startChatSession()`. `refreshBase` is async (`resolveEffectiveBaseDir` I/O); the chat session reads `storageDirRef.current` on startup, so the refresh must fully resolve first or the session opens against the old base.

## Subprocess commands

`runner.ts` runs `node …/kb` (or packaged binary) with inherited env. `partitionShellOutputForTui` splits orchestration meta vs body so tier-1 grey lines render correctly.
