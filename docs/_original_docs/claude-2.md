---
layout: default
title: CLAUDE.md - Composability first
date: '2026-04-27'
kb_id: claude-md-composability-first
tags:
  - source-excerpt
  - claude-md
  - dogfood
categories:
  - reference
---

## Composability first.
Prefer reusing existing orchestrators, intent routes, and shared utilities over one-off logic.
- Before adding a new flow, search for an existing component that already captures the behavior (`SubmitOrchestrator`, intent router, shared diff/render helpers, etc.).
- Extend shared abstractions where possible; avoid duplicating near-identical algorithms in command-specific code.
- Keep policy decisions centralized in orchestrators/intent layers; keep CLI and TUI adapters thin.
- If temporary duplication is unavoidable, document the reason and add a follow-up to converge.
