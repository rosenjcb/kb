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

Examples:

- `kb init` must support both its command-line path and the TUI `/init` path.
- `kb base use` / `kb base delete` must work as both `kb base …` (CLI) and `/base use …` / `/base delete …` (TUI).
- A help flag should work from both `kb --help` and `kb init --help`.
- A normal intent command like `kb query "topic"` is already non-interactive by shape and should not need an extra mode flag.

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
- Use `--dry-run` for non-mutating execution when the command can simulate full results.
- Use `preview` language only when the command is specifically showing a human-oriented diff or reconciliation view rather than a full dry-run execution.
- If a command supports both `--apply` and `--dry-run`, they should be mutually exclusive.
- Help text and success output should make the default clear so users are not surprised when a command previews instead of writing.

Current repo direction:

- `kb publish ...` should remain dry-run by default and only write on `--apply`.
- Commands like `kb invalidate` may still expose preview-specific UX, but should align around the same `--apply` commit step.
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
