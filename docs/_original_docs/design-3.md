---
layout: default
title: DESIGN.md - Layout
date: '2026-05-03'
kb_id: design-md-layout
tags:
  - source-excerpt
  - design-md
  - kb
categories:
  - reference
---

## Layout.
┌─ KB Agent │ base: dogfood │ mode: shell ──────────────────┐  ← StatusBar (blue border)
│                                                            │
│  KB Agent — type a command or /help                       │  ← HistoryPane
│  kb> query "what is the project?"                         │  ← command (orange)
│  KB is a local-first knowledge system…                    │  ← result (white)
│    Sources: kb-system-overview                            │
│  kb> chat                                                 │
│  Chat mode — type /exit to return to shell.               │  ← info (gray)
│  you> how does hybrid search work?                        │  ← chat-you (orange)
│  kb> Hybrid search combines BM25 + vector rerank…         │  ← chat-assistant (blue)
└────────────────────────────────────────────────────────────┘
┌─ kb> ──────────────────────────────────────────────────────┐  ← InputBar (blue border)
In chat mode the InputBar border turns orange and the prompt becomes `you>`.
