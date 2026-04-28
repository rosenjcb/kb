---
layout: default
title: Core Workflows
date: '2026-04-27'
kb_id: core-workflows
tags:
  - cli
  - tui
  - workflow
  - core-workflows
categories:
  - runbook
---

The core workflows for KB involve capturing, recalling, and repairing knowledge. These day-to-day tasks are primarily performed using the `kb` CLI or its TUI (Text User Interface) shell. Common commands include `kb submit` for capturing facts, `kb query` for recalling context, and `kb invalidate` for repairing stale knowledge. The `kb init` command is used to initialize or refresh a knowledge base, and `kb base use` manages the active knowledge base. For development, `pnpm install`, `pnpm run check`, `npm run refresh:global`, and `command -v kb` are used for installation and verification. Configuration is managed with `kb config set`. The `kb sync` command updates the managed clone of the repository. Within the TUI, interactive commands like `query "..."`, `submit "..."`, `chat`, `use <base>`, `docs list`, `docs view <id>`, `/help`, `/clear`, and `/exit` are available. For testing, `npm run precommit` runs lint, type-check, and the full test suite.
