---
layout: default
title: Interactive Shell
---

# Interactive Shell (TUI)

Running `kb` with no arguments in a TTY launches the interactive shell — a full-screen terminal UI built with [Ink](https://github.com/vadimdemedes/ink). Every feature available from one-shot CLI commands is also available from within the shell.

---

## Starting the shell

```bash
kb        # launches the interactive shell (TTY required)
```

One-shot mode (non-interactive):

```bash
kb query "topic"         # runs and exits immediately
kb submit "fact"         # same
```

The shell and one-shot commands share the same backend — there's no feature gap between them.

---

## Layout

```
┌─ KB Agent │ base: dogfood │ mode: shell ──────────────────┐
│                                                            │
│  KB Agent — type a command or /help                       │
│                                                            │
│  kb> query "what is the project?"                         │
│  KB is a local-first knowledge system…                    │
│    Sources: kb-system-overview                            │
│                                                            │
│  kb> chat                                                 │
│  Chat mode — type /exit to return to shell.               │
│  you> how does hybrid search work?                        │
│  kb> Hybrid search combines BM25 + vector rerank…         │
│                                                            │
└────────────────────────────────────────────────────────────┘
┌─ kb> ──────────────────────────────────────────────────────┐
└────────────────────────────────────────────────────────────┘
```

- **Status bar (top)** — shows the current base name and mode (shell or chat). Blue border.
- **History pane** — scrollable transcript of commands and results.
- **Input bar (bottom)** — live text input. Blue border in shell mode, orange in chat mode.

---

## Color scheme

Portal-inspired (Valve):

| Role | Color | Where |
|---|---|---|
| Primary | `#4FC3F7` (blue) | Status bar, shell prompt, KB responses |
| Secondary | `#FF7043` (orange) | Your input, chat prompt, active base name |
| Error | red | Error messages |
| Dim | gray | Info lines, separators |

---

## Shell commands

Type these at the `kb>` prompt:

| Command | Description |
|---|---|
| `query "<topic>"` | Retrieve relevant documents and show results inline |
| `submit "<fact>"` | Record a new fact, show confirmation |
| `validate "<fact>"` | Check if a claim is supported |
| `dispute "<fact>" --because "<reason>"` | Record a counter-claim |
| `chat` | Enter multi-turn chat mode |
| `use <base>` | Switch the active base; status bar updates immediately |
| `docs list` | List all documents in the active base |
| `docs view <id>` | Show a document's content |
| `init` | Run `kb init` from within the shell |

## Shell slash commands

| Slash command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Clear the history pane |
| `/exit` | Quit the shell (also Ctrl-C) |

In **chat mode**, `/exit` returns to the shell instead of quitting.

---

## Chat mode

Typing `chat` at the `kb>` prompt enters multi-turn conversation mode. The input bar turns orange and the prompt changes to `you>`.

Each turn:
1. Your message triggers a retrieval pass against the knowledge base.
2. Retrieved documents are fed to the LLM as context.
3. The LLM synthesizes an answer, with sources listed.
4. Conversation history accumulates — the LLM sees prior turns.

Type `/exit` to return to the shell without losing history.

---

## Source structure

```
src/tui/
  index.tsx          — launchTui(config) entry point
  App.tsx            — root component, state, command dispatch
  runner.ts          — runCommandForTui(), parseShellArgs()
  theme.ts           — BLUE, ORANGE color constants
  types.ts           — TuiMode, HistoryEntry, EntryType
  components/
    StatusBar.tsx     — top bar (base name + mode)
    HistoryPane.tsx   — scrollable output list
    HistoryEntryRow.tsx — single output line, type-aware coloring
    InputBar.tsx      — bottom prompt + TextInput
    LoadingSpinner.tsx — ink-spinner wrapper
```
