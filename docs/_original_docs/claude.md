---
layout: default
title: CLAUDE.md - Dogfooding
date: '2026-05-03'
kb_id: claude-md-dogfooding
tags:
  - source-excerpt
  - claude-md
  - kb
categories:
  - reference
---

## Dogfooding.
This repo uses its own `kb` CLI to record architectural decisions. After committing to a solution:
```bash
npm run refresh:global          # ensure global kb is fresh
kb query "<topic>"              # check for existing docs first
kb submit "<decision>" --base dogfood   # record durable facts
Use `--base ci-*` for disposable test traffic; never pollute `dogfood` with throwaway data.
For CLI changes, run an e2e smoke test before declaring done:
mkdir -p /tmp/kb-e2e && echo "# Test" > /tmp/kb-e2e/README.md
cd /tmp/kb-e2e && kb init --base ci-e2e --non-interactive --debug
Full workflow guidance (SPIKE tickets, open questions, plan → code → spec): see [.claude/skills/spike-ticket-workflow](/.claude/skills/spike-ticket-workflow/SKILL.md) or run `/spike-ticket-workflow` in the TUI.
