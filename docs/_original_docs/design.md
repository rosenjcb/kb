---
layout: default
title: DESIGN.md - Source Structure
date: '2026-05-03'
kb_id: design-md-source-structure
tags:
  - source-excerpt
  - design-md
  - kb
categories:
  - reference
---

## Source Structure.
src/tui/
index.tsx                 # launchTui(config) — Ink render entry
App.tsx                   # Root component, state, command dispatch
runner.ts                 # runCommandForTui(), parseShellArgs()
theme.ts                  # BLUE, ORANGE constants
types.ts                  # TuiMode, HistoryEntry, EntryType
components/
StatusBar.tsx            # Top bar
HistoryPane.tsx          # Scrollable output list
HistoryEntryRow.tsx      # Single output line (type-aware coloring)
InputBar.tsx             # Bottom prompt + TextInput
LoadingSpinner.tsx       # ink-spinner wrapper
