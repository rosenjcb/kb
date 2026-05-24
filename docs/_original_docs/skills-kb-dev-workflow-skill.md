---
layout: default
title: skills/kb:dev-workflow/SKILL.md
date: '2026-05-24'
kb_id: skills-kb-dev-workflow-skill-md
tags:
  - original-source
  - skills-kb-dev-workflow-skill-md
  - kb
categories:
  - reference
---

---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I run kb query to understand the codebase before reading files
  or exploring the repo?
---

# KB dev workflow (agent skill)

## When to use this skill

When a user gives you **any coding task**, use the `kb` CLI to develop an understanding of the project (and your task) before **ever** doing any exploration of the codebase. That means always invoking a `kb` investigation before grep, sed, awk, reading the whole file, etc. 


**DO NOT EXCESSIVELY READ FILES**
**ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING**
**KEEP CHIT CHAT TO A MINIMUM - NO TALKY**

- Primary intent: `kb query`

Also, as a final backup, we have commands to search our graph (very useful) and markdown collection: `kb graph` and `kb docs`.

If `kb` is missing or the user has no base/LLM configured, say so once and continue without pretending you ran commands.
