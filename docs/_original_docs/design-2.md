---
layout: default
title: DESIGN.md - Interactive Commands
date: '2026-04-27'
kb_id: design-md-interactive-commands
tags:
  - source-excerpt
  - design-md
  - dogfood
categories:
  - reference
---

## Interactive Commands.
| Shell input | Behaviour |
|---|---|
| `query "…"` | Runs intent, shows result inline with spinner |
| `submit "…"` | Submits fact, shows confirmation |
| `chat` | Switches to chat mode |
| `use <base>` | Switches base, StatusBar updates |
| `docs list` | Lists documents |
| `docs view <id>` | Shows document content |
| `/help` | Shows help text |
| `/clear` | Clears history |
| `/exit` | Quits (also Ctrl-C) |
| (in chat) `/exit` | Returns to shell mode |
