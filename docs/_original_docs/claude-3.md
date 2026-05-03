---
layout: default
title: CLAUDE.md - Prompts and instructions stay as Markdown
date: '2026-05-03'
kb_id: claude-md-prompts-and-instructions-stay-as-markdown
tags:
  - source-excerpt
  - claude-md
  - kb
categories:
  - reference
---

## Prompts and instructions stay as Markdown.
Do not inline prompt or skill text as TypeScript strings or template literals. Put runtime prompts in `src/prompts/*.md` and agent skills in `skills/<name>/SKILL.md`. Load them from disk via the loader utilities (`src/prompts/loader.ts`, `src/skills/loader.ts`).
