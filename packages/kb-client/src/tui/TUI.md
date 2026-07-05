---
type: Subsystem
title: TUI Implementation
description: Ink chat shell — connection status bar, slash routing, and chat bridge.
resource: ./packages/kb-client/src/tui
tags: [tui, ink, chat]
timestamp: 2026-07-05T00:00:00Z
---

# TUI Implementation (Ink)

React/Ink chat shell launched when the user runs bare `kb` in a TTY. Product-wide output tiers: [`../../kb-core/src/core/TUI.md`](../../kb-core/src/core/TUI.md).

## Connection context (first thing users see)

Pinned **`StatusBar`** (`components/StatusBar.tsx`):

```text
KB Agent │ host: localhost:38117 │ base: my-project
```

- `serverHost` — from `formatServerAddress(resolveServerConnection(config))`, passed by `launchTui` in `index.tsx`.
- `baseName` — async from `resolveEffectiveBaseDir()`; shows `…` until resolved, `(none)` if unset.
- Same `formatConnectionContext` string also prepended to TUI startup notices.

**Invariant:** host and base must stay visible for the whole session — do not hide the status bar during chat turns.

## Layout

| Component | File | Role |
|---|---|---|
| Root | `App.tsx` | Input routing, history, slash interception |
| Status | `components/StatusBar.tsx` | **host + base** (always visible) |
| History | `components/HistoryPane.tsx` | `<Static>` meta; scrollable transcript |
| Input | `components/InputBar.tsx` | Prompt + slash suggestions |
| Runner | `runner.ts` | Subprocess `kb <args>` for output-only slash commands |
| Registry | `slash-command-registry.ts` | Autocomplete source of truth |

## Slash command routing

[`slash-command-registry.ts`](slash-command-registry.ts) drives autocomplete. `App.tsx` routes:

- **Output-only** (`query`, `facts`, `graph`, `docs list`, `base`, …): `runCommandForTui` → transcript. No LLM loop.
- **Interactive** (`/docs generate`): stays on chat input; questionnaire via `ChatIO.read`.
- **Chat turns** (no `/`): `runChatSession` with `ChatIO` adapter.

Registered slash commands mirror the CLI surface in [`slash-command-registry.ts`](slash-command-registry.ts).

## `ChatIO` bridge

`App.tsx` implements `ChatIO` for `chat-cli.ts`:

- Remote chat: `runRemoteChatSession` prints `formatConnectionContext` first.
- Local chat: same string via `printer.chatAssistant` before the prompt hint.
- Meta lines (`retrieval>`, …) → `chat-meta` tier — never held in loading accumulator.

## Subprocess commands

`runner.ts` runs packaged `kb` with inherited env (including `--host` overrides from the parent process). `partitionShellOutputForTui` splits meta vs body.

## Extension checklist

1. Add `SlashCommandSpec` row if new slash command.
2. Output-only → `isOutputOnlyCommand()` in `App.tsx`.
3. Destructive flows → `setPendingConfirm` before `runCommandForTui`.
4. New surface → keep **StatusBar** host/base visible; do not add init/scan progress UI on client.

## Related docs

- Connection → [`../api/CONNECTION.md`](../api/CONNECTION.md)
- CLI router → [`../cli/CLI.md`](../cli/CLI.md)
- Output tiers → [`../../kb-core/src/core/TUI.md`](../../kb-core/src/core/TUI.md)
- Client package → [`../../CLIENT.md`](../../CLIENT.md)
