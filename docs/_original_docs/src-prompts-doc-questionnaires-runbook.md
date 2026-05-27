---
layout: default
title: src/prompts/doc-questionnaires/runbook.md
date: '2026-05-26'
kb_id: src-prompts-doc-questionnaires-runbook-md
tags:
  - original-source
  - src-prompts-doc-questionnaires-runbook-md
  - kb
categories:
  - reference
---

# Runbook checklist

- documentTitle: Short KB title (about 3–10 words). **Runbook label** (e.g. `Dogfood base resync`) — not a full sentence; no trailing period.
- trigger: When should someone run this (symptoms, alerts, schedule)?
- steps: Ordered operational steps (commands with placeholders OK).
- rollback: How to undo or mitigate if the run fails?
- verification: How to confirm healthy state after?
