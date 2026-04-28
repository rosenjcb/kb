---
layout: default
title: EVALUATION.md - Secondary Questions
date: '2026-04-27'
kb_id: evaluation-md-secondary-questions
tags:
  - source-excerpt
  - evaluation-md
  - dogfood
categories:
  - reference
---

## Secondary Questions.
1. Does `kb init` produce a usable knowledge base from the current repo without manual surgery?
2. Does the resulting KB support both retrieval-style questions (`kb query`) and synthesis-style questions (`kb chat`) across multiple topic areas?
3. Is the resulting graph store populated enough to plausibly improve retrieval and follow-up questioning?
4. What is the cost of producing this KB in time, tokens, and operator effort?
5. In a later comparison run, does a dedicated KB-maintenance agent improve outcomes versus a single-agent baseline?
