---
layout: default
title: KB Architecture Overview
date: '2026-04-27'
kb_id: kb-architecture-overview
tags:
  - architecture
  - components
  - system-design
categories:
  - architecture
---

KB is a local-first knowledge layer for development workflows, providing a CLI and runtime to capture project knowledge. The high-level architecture of KB involves several main components that interact to provide its functionality. The core components are organized into `src/core`, `src/cli`, and `src/tools` directories. `src/core` contains the provider abstraction, intent loop, agent loop, and runtime types. `src/cli` handles the CLI entrypoint, KB intent parsing, base selection, and `kb init` functionality. `src/tools` includes write/query tools, markdown, and SQLite index integration. The system uses a SQLite database to store knowledge, with named bases storing their data under `~/.kb/sessions/<base>/`. The `kb` CLI and TUI (Terminal User Interface) provide the user interface, with `src/tui` containing the TUI's components and logic. The system is designed for composability, preferring the reuse of existing orchestrators, intent routes, and shared utilities. Policy decisions are centralized in orchestrators and intent layers, keeping CLI and TUI adapters thin. Testing is done with Vitest, with source files mirroring their tests in the `tests/` directory. The system also supports agent instructions, with prompts and instructions stored as Markdown files in `src/prompts/*.md` and `skills/<name>/SKILL.md` respectively.
