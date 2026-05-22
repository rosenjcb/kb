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

## Slash command routing

`slash-commands.ts` lists suggestions; `App.tsx` decides handling:

- **Output-only** (`query`, `submit`, `facts`, `graph`, `docs list`, `base`, `config`, …): `runCommandForTui` → stdout partitioned via `partition-shell-output.ts` → transcript entries. No LLM loop.
- **Interactive** (`/init`, `/scan`, `/docs generate`): stay on chat input surface; progress uses `InitProgressBar`, not history spam.
- **Chat turns** (no leading `/`): `runChatSession` with `ChatIO` adapter classifying each line (`chat-io-classify.ts`).

`normalizeSlashCommandArgs` strips redundant leading `/` on first token so `kb` argv matches CLI parsing.

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

## Subprocess commands

`runner.ts` runs `node …/kb` (or packaged binary) with inherited env. `partitionShellOutputForTui` splits orchestration meta vs body so tier-1 grey lines render correctly.

## Extension checklist

1. Add slash to `slash-commands.ts` with description.
2. If output-only: add to `isOutputOnlyCommand()` in `App.tsx` and ensure CLI supports the same argv shape.
3. Respect three output tiers from `../core/TUI.md`.
4. User-facing success copy: slash form via `cmd('…', 'tui')`.
