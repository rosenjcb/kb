---
layout: default
title: EVALUATION.md - Evaluation Design
date: '2026-04-27'
kb_id: evaluation-md-evaluation-design
tags:
  - source-excerpt
  - evaluation-md
  - dogfood
categories:
  - reference
---

## Evaluation Design.
This evaluation should be run at least twice against the same codebase snapshot or equivalent branch state:
1. Baseline run:
- Build the KB from scratch with the normal workflow.
- No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately.
2. Comparison run:
- Repeat on a fresh disposable base after using the intended two-agent workflow.
- Keep the question set, scoring rubric, and artifact schema identical.
