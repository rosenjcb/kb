---
type: "Design Doc"
title: "KB TUI Design"
description: "Visual design language for the KB terminal UI — color scheme, layout, and component styling."
resource: ./src/tui
tags: [tui, design, ux]
timestamp: 2026-06-20T00:00:00Z
---

# KB TUI Design

## Color Scheme

Portal-inspired (Valve). Blue is primary; orange is secondary.

| Role      | Color     | Usage                                      |
|-----------|-----------|--------------------------------------------|
| Primary   | `#4FC3F7` | Status bar, shell prompt, assistant output |
| Secondary | `#FF7043` | User input, chat you-prompt, base name     |
| Error     | red       | Error messages                             |
| Dim       | gray      | Info lines, separators                     |

## Layout

```
┌─ KB Agent │ base: dogfood │ mode: shell ──────────────────┐  ← StatusBar (blue border)
│                                                            │
│  KB Agent — type a command or /help                       │  ← HistoryPane
│                                                            │
│  kb> query "what is the project?"                         │  ← command (orange)
│  KB is a local-first knowledge system…                    │  ← result (white)
│    Sources: kb-system-overview                            │
│                                                           │
│  kb> chat                                                 │
│  Chat mode — type /exit to return to shell.               │  ← info (gray)
│  you> how does hybrid search work?                        │  ← chat-you (orange)
│  kb> Hybrid search combines BM25 + vector rerank…         │  ← chat-assistant (blue)
│                                                           │
└────────────────────────────────────────────────────────────┘
┌─ kb> ──────────────────────────────────────────────────────┐  ← InputBar (blue border)
└────────────────────────────────────────────────────────────┘
```

In chat mode the InputBar border turns orange and the prompt becomes `you>`.

## TUI vs One-Shot

- `kb` (no args, TTY) → launches TUI
- `kb <command> [args]` → one-shot CLI (non-interactive by default)

## Interactive Commands

| Shell input | Behaviour |
|---|---|
| `query "…"` | Runs intent, shows result inline with spinner |
| `base use <base>` | Switches base, StatusBar updates |
| `facts list` | Lists curated facts inline |
| `graph` / `entities` / `logs` / `session` | Output-only commands rendered inline |
| `/help` | Shows help text (rendered inline, not sent to chat) |
| `/clear` | Ends the chat session (saved to logs), clears the screen |
| `/exit` | Quits (also Ctrl-C) |

## Source Structure

```
src/tui/
  index.tsx                 # launchTui(config) — Ink render entry
  App.tsx                   # Root component, state, command dispatch
  runner.ts                 # runCommandForTui(), parseShellArgs()
  theme.ts                  # BLUE, ORANGE constants
  types.ts                  # TuiMode, HistoryEntry, EntryType
  components/
    StatusBar.tsx            # Top bar
    HistoryPane.tsx          # Scrollable output list
    HistoryEntryRow.tsx      # Single output line (type-aware coloring)
    InputBar.tsx             # Bottom prompt + TextInput
    LoadingSpinner.tsx       # ink-spinner wrapper
```
