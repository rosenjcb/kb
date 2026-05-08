# Agent Instructions

Operating rules for all coding agents in this repository (Claude, Cursor, Codex, GitHub Copilot).

## TUI / CLI parity

Every user-facing feature must work both as `kb <command>` (one-shot CLI) and `/command` (TUI shell) unless there is an explicit reason not to. See [src/core/TUI.md](src/core/TUI.md) before adding or changing commands.

## Prompts and instructions stay as Markdown

Do not inline prompt or skill text as TypeScript strings or template literals. Put runtime prompts in `src/prompts/*.md` and agent skills in `skills/<name>/SKILL.md`. Load them from disk via the loader utilities (`src/prompts/loader.ts`, `src/skills/loader.ts`).

## Composability first

Prefer reusing existing orchestrators, intent routes, and shared utilities over one-off logic.

- Before adding a new flow, search for an existing component that already captures the behavior (`SubmitOrchestrator`, intent router, shared diff/render helpers, etc.).
- Extend shared abstractions where possible; avoid duplicating near-identical algorithms in command-specific code.
- Keep policy decisions centralized in orchestrators/intent layers; keep CLI and TUI adapters thin.
- If temporary duplication is unavoidable, document the reason and add a follow-up to converge.

## Testing

All non-trivial logic needs unit tests before a PR merges. See [TESTING.md](TESTING.md) for naming conventions, file layout, and what to cover.

Pre-commit gate: `npm run precommit` (lint + type-check + tests). Must pass before pushing.

## Dogfooding

This repo uses its own `kb` CLI to record architectural decisions. After committing to a solution:

```bash
npm run install:global          # ensure global kb is fresh
kb query "<topic>"              # check for existing docs first
kb submit "<decision>" --base kb   # record durable facts
```

Use `--base ci-*` for disposable test traffic; never pollute `kb` with throwaway data.

For CLI changes, run an e2e smoke test before declaring done:

```bash
mkdir -p /tmp/kb-e2e && echo "# Test" > /tmp/kb-e2e/README.md
cd /tmp/kb-e2e && kb init --base ci-e2e --non-interactive --debug
```

Full workflow guidance (SPIKE tickets, open questions, plan → code → spec): see [.claude/skills/spike-ticket-workflow](/.claude/skills/spike-ticket-workflow/SKILL.md) or run `/spike-ticket-workflow` in the TUI.
