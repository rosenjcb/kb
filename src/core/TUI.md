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

Examples:

- `kb init` must support both its command-line path and the TUI `/init` path.
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
