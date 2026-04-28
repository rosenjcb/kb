---
layout: default
title: CLAUDE.md - TUI / CLI parity
date: '2026-04-27'
kb_id: claude-md-tui-cli-parity
tags:
  - source-excerpt
  - claude-md
  - dogfood
categories:
  - reference
---

## TUI / CLI parity.
Every user-facing feature must work both as `kb <command>` (one-shot CLI) and `/command` (TUI shell) unless there is an explicit reason not to. See [src/core/TUI.md](src/core/TUI.md) before adding or changing commands.
