---
layout: default
title: EVALUATION.md - Evaluation Target
date: '2026-05-03'
kb_id: evaluation-md-evaluation-target
tags:
  - source-excerpt
  - evaluation-md
  - kb
categories:
  - reference
---

## Evaluation Target.
**Canonical external benchmark:** the [raylib C library](https://github.com/raysan5/raylib) — use suite `raylib` (its `repo_url` is defined in `eval/suites/raylib.yaml`; override with `--repo` only when needed).
Reasons: mature, well-documented, not kb itself (avoids evaluator familiarity bias), rich graph structure, stable upstream.
**Kb self-check:** suite `kb` (its `repo_url` is defined in `eval/suites/kb.yaml`; override with `--repo` only when needed). That is a product smoke test, not the primary raylib benchmark.
For day-to-day kb architecture work on your checkout, use `--base dogfood` (separate from disposable eval bases).
### Base naming convention
| Base | Purpose | Lifetime |
|------|---------|----------|
| `<repo-leaf>-YYYY-MM-DD-HHmm` | Default disposable base from `eval-run.mjs`: **same string** as `~/.kb/evaluations/<run-name>/` (override with `--base`) | Ephemeral |
| `raylib` | Persistent agent comparison base — accumulates across tasks, never wiped | Permanent |
| `dogfood` | kb's own architectural knowledge | Permanent |
The `raylib` base is the KB that a KB-backed agent would actually use during real development on a long-lived raylib tree. Do not reuse ephemeral eval run names for it — the compounding hypothesis requires the same base to persist across multiple task sessions.
### Published docs location
Eval runs do **not** publish Jekyll output. We only capture init/query evidence artifacts.
