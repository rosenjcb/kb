---
layout: default
title: KB Architecture Overview
date: '2026-05-03'
kb_id: kb-architecture-overview
tags:
  - architecture
  - components
  - cli
  - tui
  - knowledge-base
categories:
  - introduction
---

KB is a local-first knowledge layer for development workflows, designed to capture and recall project context. Its high-level architecture consists of a core, a CLI, and tools, with a TUI providing an interactive shell. The `src/core` directory contains the provider abstraction, intent loop, agent loop, and runtime types, forming the central logic of the system. The `src/cli` directory handles the CLI entrypoint, KB intent parsing, base selection, and initialization processes. The `src/tools` directory includes functionalities for writing and querying, along with markdown and SQLite index integration. The TUI (Terminal User Interface) is built using Ink and React, with `src/tui/index.tsx` as the launch entry and `src/tui/App.tsx` as the root component managing state and command dispatch. Key components within the TUI include `StatusBar`, `HistoryPane`, `InputBar`, and `LoadingSpinner`. The system supports both one-shot CLI commands (`kb <command>`) and an interactive TUI shell (`kb` with no arguments). Knowledge bases are stored as SQLite data under `~/.kb/sessions/<base>/`, and configuration is managed in `~/.kb/config.json`.
