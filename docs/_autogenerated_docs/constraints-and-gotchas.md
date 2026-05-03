---
layout: default
title: Constraints And Gotchas
date: '2026-05-03'
kb_id: constraints-and-gotchas
tags:
  - constraints
  - gotchas
  - cli
  - tui
  - node
  - constraints-gotchas
categories:
  - reference
---

Several important constraints and potential gotchas are easy to miss when working with KB. KB expects Node.js version 22+ in the shell that runs `kb`. The `kb base use` command is session-scoped by default; to make a base persistent across sessions, the `--default` flag must be used (e.g., `kb base use --default <base>`). All user-facing features must work both as a one-shot CLI command (`kb <command>`) and within the TUI shell (`/command`), unless explicitly justified. Runtime prompts and agent skills must be stored as Markdown files on disk (in `src/prompts/*.md` and `skills/<name>/SKILL.md` respectively) and loaded via utilities, not inlined as TypeScript strings. When developing, temporary duplication of logic should be documented with a follow-up plan to converge. All non-trivial logic requires unit tests before a PR merges, and the `npm run precommit` gate (lint + type-check + tests) must pass before pushing. For evaluation, the `dogfood` base is for KB's own architectural knowledge and should not be polluted with disposable test data; use `--base ci-*` for temporary test traffic.
