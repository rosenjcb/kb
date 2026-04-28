---
layout: default
title: EVALUATION.md - Standard Procedure
date: '2026-04-27'
kb_id: evaluation-md-standard-procedure
tags:
  - source-excerpt
  - evaluation-md
  - dogfood
categories:
  - reference
---

## Standard Procedure.
### Phase 1: Initialize a Fresh KB
From the target repo root (or a clone):
1. Run: `kb init --base raylib-2026-04-27-1303 --non-interactive` (pick a fresh disposable name; `eval-run.mjs` generates this pattern automatically).
2. Or interactively: start `kb`, then `/init --base <same>`
3. Let `kb init` complete all passes through `pass-graph`.
4. Save the resulting run metadata.
Use a disposable base name that matches your eval run folder when using `eval-run.mjs`, or any unique name for manual runs.
### Phase 2: Capture Build Metrics
Collect:
- Base name
- Git branch and commit of `~/raylib/`
- Start/end timestamps
- `kb init` run ID from `kb logs`
- Total init duration
- Total init input tokens
- Total init output tokens
- Estimated init cost
- Number of documents created
- Graph entity count
- Graph relationship count
### Phase 3: Evaluate Answer Quality
Run a fixed question set:
- `kb query "<question>" --base ci-raylib-<date> --output json`
- `kb chat` against the same base (optional, mark `not_captured` if skipped)
Questions adapted for raylib (see Canonical Question Set below).
### Phase 4: Score the Results
Each question gets a rubric score on four axes. Use `--auto-score` with the eval runner when available.
### Phase 5: Publish
```bash
kb publish jekyll --base ci-raylib-<date> --dir ~/raylib-kb-docs/ --apply
