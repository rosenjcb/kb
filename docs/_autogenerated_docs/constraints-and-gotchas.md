---
layout: default
title: Constraints and Gotchas
date: '2026-04-27'
kb_id: constraints-and-gotchas
tags:
  - constraints
  - gotchas
  - cli
  - tui
  - development
  - constraints-gotchas
categories:
  - checklist
---

Several important constraints and potential gotchas are easy to miss when working with KB. KB expects Node 20+ in the shell that runs `kb`. Every user-facing feature must work both as `kb <command>` (one-shot CLI) and `/command` (TUI shell) unless there is an explicit reason not to. Prompts and instructions must stay as Markdown files and not be inlined as TypeScript strings or template literals. Policy decisions should be centralized in orchestrators/intent layers, keeping CLI and TUI adapters thin. All non-trivial logic needs unit tests before a PR merges, and `npm run precommit` must pass before pushing. For CLI changes, an e2e smoke test should be run before declaring completion. The `dogfood` base should not be polluted with throwaway data; use `--base ci-*` for disposable test traffic. The `raylib` base is intended for persistent agent comparison and should not be reused for ephemeral evaluation runs.
