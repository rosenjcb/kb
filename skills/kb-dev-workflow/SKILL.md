---
name: kb-dev-workflow
description: >-
  Use the kb CLI during implementation and review: query before big changes,
  submit durable facts, invalidate stale knowledge, and keep the active KB
  base aligned. Use when the repo uses KB (local-first knowledge) or when the
  user expects durable project memory.
---

# KB dev workflow (agent skill)

## When to use this skill

When a user gives you **any coding task**, use the `kb` CLI to develop an understanding of the project (and your task) before **ever** doing any exploration of the codebase. That means always invoking a `kb` investigation before grep, sed, awk, reading the whole file, etc. 

- One read intent: `kb query`
- Two mutation intents: `kb submit` and `kb invalidate`

As the task is progressing, use the mutation commands to update the knowledge store with new facts about the system. Do not prematurely insert facts - only when decisions are made and committed to in code.

If `kb` is missing or the user has no base/LLM configured, say so once and continue without pretending you ran commands.
