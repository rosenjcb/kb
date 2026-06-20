---
type: "Reference"
title: "Eval Question Suites"
description: "YAML schema and conventions for the question packs loaded by --suite."
resource: ./eval/suites
tags: [eval, suites, yaml]
timestamp: 2026-06-20T00:00:00Z
---

# Eval question suites (YAML)

`--suite <name>` loads `eval/suites/<name>.yaml` (or `.yml`). `--suite` can also be a path to a YAML file.

Each file needs: `id`, `rubric_focus`, exactly **8** `questions`, and optionally:
- `repo_url` (default clone URL used when `--repo` is omitted)

Disposable KB base names are **not** configured here — `eval-run.mjs` defaults `--base` to the run folder name (`<repo-leaf>-YYYY-MM-DD-HHmm`, same string as `~/.kb/evaluations/<that>/`). Override with `--base` if needed.

## Headline grade (ΔS)

Each suite run (with `--auto-score`, control phase on) produces **`artifact.comparison.success_score.delta_kb_minus_control`** — the single scalar that answers “does kb beat a real agent on this question pack?” Both sides get the same `success_score` formula (quality + tokens + speed). See `EVALUATION.md` § Headline verdict.

```bash
pnpm run eval -- --suite kb --auto-score          # kb + control → ΔS
pnpm run eval -- --suite raylib --auto-score      # primary external benchmark
```
