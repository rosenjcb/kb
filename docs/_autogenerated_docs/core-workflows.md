---
layout: default
title: Core Workflows
date: '2026-05-03'
kb_id: core-workflows
tags:
  - cli
  - tui
  - workflow
  - commands
  - core-workflows
  - source-excerpt
  - design-md
  - kb
categories:
  - reference
---

The core workflows in KB revolve around capturing, recalling, and repairing knowledge. These day-to-day tasks are primarily performed using the `kb` CLI or the interactive TUI. Key commands include `kb submit` for capturing facts, `kb query` for recalling context, and `kb invalidate` for repairing stale knowledge. Installation and setup involve `pnpm install`, `pnpm run check`, `npm run refresh:global`, and configuring `~/.kb/config.json` for the LLM provider. Initializing a knowledge base is done with `kb init --base <base-name>`, and refreshing an existing base uses `kb init --rescan` or `kb init --rescan --apply`. To switch between knowledge bases, `kb base use <base>` is used, with `kb base use --default <base>` setting a persistent default. The `kb sync` command updates the managed clone and relinks globally. Development commands include `pnpm run test`, `pnpm run type-check`, `pnpm run lint`, and `pnpm run build`. The TUI offers interactive commands like `query "..."`, `submit "..."`, `chat`, `use <base>`, `docs list`, `docs view <id>`, `/help`, `/clear`, and `/exit`.
## TUI vs One-Shot
- `kb` (no args, TTY) → launches TUI
- `kb <command> [args]` → one-shot CLI (non-interactive by default)
