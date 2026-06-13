# TUI and Non-Interactive Standards

Ink implementation details: [`../tui/TUI.md`](../tui/TUI.md). Use this note when designing or reviewing any user-facing `kb` feature.

## Core Rule

Every meaningful CLI feature must be usable in the right mode surfaces:

- Interactive chat TUI when the user starts with bare `kb` (chat is the primary experience)
- One-shot non-interactive CLI entry when the user runs `kb <command> ...`
- Help entry via `--help`
- TUI slash entry such as `/init` when the feature is available from the chat interface

Do not treat the TUI path as extra polish. It is part of the product surface.

## Interaction Contract

- `kb` in a real TTY launches directly into chat mode. There is no shell mode — chat is the default.
- `kb --help` should print top-level help and exit.
- `kb <command> ...` should be non-interactive by default unless that command intentionally runs a session flow.
- `kb <command> --help` should print help and exit without starting real work.
- All commands are available as slash commands inside the chat interface. Slash commands that are output-only (query, facts, graph, docs list/view, base, config, etc.) are intercepted at the TUI layer and display inline without involving the LLM loop. Interactive slash commands (`/init`, `/scan`, `/docs generate`) still use the chat session input surface, but init/scan progress should render in a dedicated live status row rather than being appended to transcript history. If no chat read is active, the TUI may run `/init` or `/scan` directly and preserve the same dedicated progress-line behavior.
- Success or follow-up copy in the TUI transcript should use **slash form** (`/base use …`), not `kb …`, so users are not told to leave the chat interface. Shared formatters take `CmdMode` and build hints via `cmd()` in `src/cli/cmd-ref.ts`.
- `/docs generate` review uses slash commands only: `/accept`, `/reject <feedback>`, `/cancel`.
- `/init` and `/scan` question answering uses `/skip` and `/cancel` as slash commands.

## Output Model — Three Tiers

Every piece of output belongs to exactly one of these tiers. Get the tier wrong and you get double-renders, scrollback pollution, or a confusing UX.

### Tier 1 — Metadata (immediate, permanent, grey)

Orchestration wire lines written with `formatOrchestrationMetaLine(key, value)` — `retrieval>`, `evidence>`, `sources>`, `matches>`, `sep>`, `thinking>`, etc.

- Written immediately via `chatIO.write()` / `printer.orchestrationMeta()`.
- Classified by `classifyChatIOLine` → `category: 'meta'`.
- Added directly to history as `chat-meta` entries (grey, no spinner).
- Go through `<Static>` — permanent in terminal scrollback.
- **Never accumulate these in a loading state.** They are context for the user, not "in progress".

### Tier 2 — Progress (transient, live area only)

The visual state shown *while* an async job is running. Comprises:

a. **Spinner** — always present (blue `LoadingSpinner` component). Signals "something is happening".

b. **Grey context lines** — last ≤6 lines of the in-flight content, capped at 100 chars/line, shown below the spinner in grey/dim (`LoadingSpinner` renders these from `entry.content`). Shows enough context to know what's happening without polluting scrollback.

Both live exclusively in `liveItems` (entries with `loading: true`). Ink renders these in its mutable live area at the bottom of the terminal — they can be updated or cleared without touching scrollback.

**Rule:** Never let Tier 2 content exceed ~6 lines. If the streaming content is longer, `LoadingSpinner` truncates it (shows only the tail). This prevents the live area from scrolling into the scrollback buffer, which would cause a double-render when the result is finally committed.

### Tier 3 — Content (committed once, permanent)

The final result of an operation — the answer text, a document body, a diff, command output.

- Committed to history as a non-loading entry *exactly once*, after the job finishes.
- Goes through `<Static>` — permanent in terminal scrollback.
- For **output-only commands** (docs view/list, query, facts, etc.): the full output is held in `resultId` with `loading: true` during the run, then `loading: false` flipped when done. `LoadingSpinner` shows only the grey tail while running.
- For **chat responses**: assistant lines accumulate in `chatResponseIdRef` (a single `loading: true` entry). `finalizeChatResponse()` flips it to `loading: false` when `chatIO.read()` is called (the turn boundary). This means the full response — whether two words or a 200-line document — is committed to scrollback exactly once.
- For **init/scan progress**: shown via `InitProgressBar` in the live area (spinner + grey status line), never written to history.

### Applying the model to new features

| What you're building | Tier | API |
|---|---|---|
| Orchestration status (retrieval, routing) | 1 | `printer.orchestrationMeta()` → `chatIO.write()` |
| LLM answer / doc body / diff | 3 | `printer.chatAssistant()` → accumulates in loading entry |
| Init/scan phase progress | 2 | `progressSink` → `setProgressLine` → `InitProgressBar` |
| Output-only command result | 3 | `out.write()` → `runCommandForTui` loading entry |
| Error | — | `chatIO.error()` → finalizes any open response, then `addEntry` |

When adding a new tool, agent, or orchestrator output path: ask "is this metadata the user needs for context (T1), transient progress (T2), or the final result (T3)?" Wire accordingly. **Do not mix tiers on the same output path.**

## Terminal scrollback (Ink)

- Completed transcript rows should go through Ink `<Static>` where they must not be redrawn every frame, so the host TTY keeps them in normal scrollback (see `src/tui/components/HistoryPane.tsx`).
- Init/scan progress bars are not chat history. Keep them in a dedicated live component near the input area (for example `InitProgressBar`) so rapid progress updates do not pollute scrollback with transient `[init]` / `[scan]` frames.
- **Cursor’s integrated terminal** can behave differently from iTerm, Terminal.app, or VS Code’s terminal panel (e.g. scrollback feels “stuck”). If the issue appears only there, try an external terminal to confirm; the `<Static>` split is still the right default for real TTYs.
- `read()` in `ChatIO` echoes any **non-idle** prompt into the transcript and reuses a short form as the input placeholder so questionnaire / review steps (docs generate, init questions) read as a normal back-and-forth.

Examples:

- `kb init` must support both its command-line path and the TUI `/init` path (runs interactively inside the chat session).
- `kb scan` must support both its command-line path and the TUI `/scan` path.
- `kb base use` / `kb base delete` must work as both `kb base …` (CLI) and `/base use …` / `/base delete …` (TUI).
- `kb sync` must work as both `kb sync` (CLI) and `/sync` (TUI).
- A help flag should work from both `kb --help` and `kb init --help`.
- A normal intent command like `kb query “topic”` is already non-interactive by shape and should not need an extra mode flag.
- The public intent surface is `kb query`, mirrored by `/query` in chat.
- **`kb query` vs chat are intentionally different synthesis paths.** Shared retrieval (`runQueryTruthRetrieval`); divergent answer phase. `kb query` = one-shot `enrichReadDocumentsAnswerWithLLM()` (single LLM call, eval harvest). Chat = multi-turn `runChatSynthesis()` with optional `query_kb` follow-ups. Do not collapse these paths.
- **`kb facts`** (list / search / show) must work as **`/facts …`** in chat, mirroring the same flags as the CLI.

## Flag Standardization Guidance

- Do not add new mode flags casually.
- Prefer entrypoint-driven behavior:
  - bare `kb` => interactive shell
  - `kb <command>` => one-shot non-interactive command
- Reserve `--non-interactive` for commands that otherwise prompt the user during their own command flow (e.g. `kb init`).
- Before renaming or removing any existing flag, verify current semantics, help output, scripts, tests, and TUI dispatch paths.

Current repo guidance:

- Subcommands are already one-shot by default; adding `--non-interactive` to them is redundant.
- Mode flags should be reduced, not multiplied.

## Mutation Safety Guidance

For commands that can mutate durable KB state or external systems, prefer a consistent safety contract:

- Default to a non-mutating mode unless the user explicitly opts into writes.
- Use `--apply` as the shared opt-in flag for real writes.
- Do not expose a "preview mode" flag — default (no flag) is already preview/no-op.
- Help text and success output should make the default clear so users are not surprised when a command previews instead of writing.

Current repo direction:

- `kb publish ...` previews by default and only writes on `--apply`.
- `kb scan` applies its refresh plan immediately; it should not stop for a separate proceed/apply ceremony.
- Any preview-by-default command should, in interactive mode, show the plan then ask "Apply? [y/N]" rather than requiring the user to re-run with `--apply` manually.
- Avoid inventing command-specific synonyms for "really do it" when `--apply` already fits.

## Validation Checklist

For any new or changed user-facing command, verify the relevant subset of:

- `kb`
- `kb --help`
- `kb <command> --help`
- `kb <command> ...`
- TUI slash invocation such as `/init`
- Real-TTY behavior, not only unit tests

For high-risk CLI changes, keep the repository rule from `AGENTS.md`: run end-to-end validation with `kb init` using a disposable `ci-*` base before declaring completion.

## Known Gaps to Watch

- `kb init --help` should behave like help, not kick off or resume init work.

## Prerequisites and errors (DRY)

Many commands need **exactly one** of these at a time, and errors must name the missing prerequisite clearly (never “A or B” when both matter):

1. **Knowledge base** — an effective base (`config.activeBase` or `config.defaultBase`), or an explicit `--base <name>` on commands that support it.
2. **LLM** — a constructible provider from `~/.kb/config.json` + environment keys (`kb config llm`).

Canonical user-facing strings live in `src/cli/cli-prerequisites.ts` (`CLI_ERROR_NO_KB_BASE`, `CLI_ERROR_NO_LLM_PROVIDER`, etc.). CLI and TUI should reuse them so `/query` and `kb query` behave the same as bare `kb` + slash commands.

When a command needs both base and LLM config (e.g. the interactive session), check **base first**, then **LLM**, and surface **one** error at a time.
