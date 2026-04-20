---
layout: default
title: Dogfood Interaction Mode
date: '2026-04-20'
kb_id: dogfood-interaction-mode
tags:
  - dogfood
  - interaction
  - cli
categories:
  - decision
---

In the dogfood workspace, the default interaction mode is intent-first, using commands like `submit`, `validate`, `query`, `explain`, and `invalidate`. Freeform interactions are exceptions and used only when explicitly requested or necessary.

- ValidateOrchestrator in src/tools/validate-orchestrator.ts implements shallow→deep escalation for fact validation. Shallow probe returns valid if content supports the fact token-overlap; escalates to deep if no support found. (source: consumer)
