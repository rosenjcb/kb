---
layout: default
title: Constraints And Gotchas
date: '2026-04-20'
kb_id: constraints-and-gotchas
tags:
  - configuration
  - errors
  - base management
  - constraints-gotchas
categories:
  - checklist
---

KB has specific constraints and potential gotchas related to base configuration and error handling that users should be aware of.<ul><li>**Base Resolution Order:** When determining the active knowledge base, KB prioritizes `activeBase` (set by `kb use <base>`) over `selectedBase` (a persistent default set by `kb use --default <base>` or `kb default <base>`). This means a temporary session base will override a persistent default.</li><li>**Error Handling Specificity:** Prerequisites are validated separately. If no base is configured, a "knowledge base" error is returned. If no LLM credentials or provider are available, an "LLM" error is returned. These errors are never combined, meaning you'll only see one specific error at a time, not an "either/or" message. The canonical copy of this logic resides in `src/cli/cli-prerequisites.ts`.</li><li>**Session-Scoped `kb use`:** The `kb use <base>` command sets the active base only for the current session. To make a base persistent across sessions, you must use `kb use --default <base>`.</li></ul>
