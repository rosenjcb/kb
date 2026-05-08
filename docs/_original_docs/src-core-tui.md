---
layout: default
title: src/core/TUI.md
date: '2026-05-08'
kb_id: src-core-tui-md
tags:
  - original-source
  - src-core-tui-md
  - kb
categories:
  - reference
---

# TUI and Non-Interactive Standards

Use this note when designing or reviewing any user-facing `kb` feature.

## Core Rule

Every meaningful CLI feature must be usable in the right mode surfaces:

- Interactive shell/TUI entry when the user starts with bare `kb`
- One-shot non-interactive CLI entry when the user runs `kb <command> ...`
- Help entry via `--help`
- TUI slash entry such as `/init` when the feature is available from the Ink shell

Do not treat the TUI path as extra polish. It is part of the product surface.

## Interaction Contract

- `kb` in a real TTY should launch the interactive TUI shell.
- `kb --help` should print top-level help and exit.
- `kb <command> ...` should be non-interactive by default unless that command intentionally runs an interview or session flow.
- `kb <command> --help` should print help and exit without starting real work.
- If a command is exposed inside the TUI, the slash path should mirror the CLI path closely enough that the same feature can be exercised both ways.
- Success or follow-up copy in the TUI transcript (e.g. after `/base use` or `/base use --default`) should use **slash form** (`/base use …`), not `kb …`, so users are not told to leave the Ink shell. Shared formatters take `CmdMode` and build hints via `cmd()` in `src/cli/cmd-ref.ts`.

## Terminal scrollback (Ink)

- Completed transcript rows should go through Ink `<Static>` where they must not be redrawn every frame, so the host TTY keeps them in normal scrollback (see `src/tui/components/HistoryPane.tsx`).
- **Cursor’s integrated terminal** can behave differently from iTerm, Terminal.app, or VS Code’s terminal panel (e.g. scrollback feels “stuck”). If the issue appears only there, try an external terminal to confirm; the `<Static>` split is still the right default for real TTYs.
- In **Ink chat mode**, `read()` used to drop the prompt string (only the shell showed `you>`). Sub-flows such as `/docs generate` now echo any **non-idle** prompt into the transcript and reuse a short form as the input placeholder so questionnaire / review steps read as a normal back-and-forth.

Examples:

- `kb init` must support both its command-line path and the TUI `/init` path.
- `kb scan` must support both its command-line path and the TUI `/scan` path.
- `kb base use` / `kb base delete` must work as both `kb base …` (CLI) and `/base use …` / `/base delete …` (TUI).
- `kb sync` must work as both `kb sync` (CLI) and `/sync` (TUI) when release-install commands are exposed.
- A help flag should work from both `kb --help` and `kb init --help`.
- A normal intent command like `kb query "topic"` is already non-interactive by shape and should not need an extra mode flag.
- The public intent surface is exactly `kb query`, `kb submit`, and `kb invalidate`, mirrored by `/query`, `/submit`, and `/invalidate` in the TUI shell.
- **`kb facts`** (list / search / show) must work as **`/facts …`** in the TUI shell (and in chat mode for parity), mirroring the same flags as the CLI.
- **`--verbose`** on **`kb query`** / **`kb chat`** adds human rows **`summary>`** / **`status>`** / **`confidence>`**. **`--debug`** switches the default **`sources>`** (titles-only) footer to one detailed **`source>`** line per hit. Use these on that invocation (TUI shell: **`chat --verbose`**, **`chat --debug`**) before a chat session starts—there is no mid-session toggle.

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
- Use `--preview` only for `kb invalidate`, where the default is to apply (reversed semantics).
- Help text and success output should make the default clear so users are not surprised when a command previews instead of writing.

Current repo direction:

- `kb publish ...` previews by default and only writes on `--apply`.
- `kb scan` previews by default and only writes on `--apply`.
- `kb invalidate` previews by default and only writes on `--apply`.
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

When a command needs both (e.g. `kb chat`), check **base first**, then **LLM**, and surface **one** error at a time.
