---
layout: default
title: eval/suites/README.md
date: '2026-05-08'
kb_id: eval-suites-readme-md
tags:
  - original-source
  - eval-suites-readme-md
  - kb
categories:
  - reference
---

# Eval question suites (YAML)

`--suite <name>` loads `eval/suites/<name>.yaml` (or `.yml`). `--suite` can also be a path to a YAML file.

Each file needs: `id`, `rubric_focus`, exactly **8** `questions`, and optionally:
- `repo_url` (default clone URL used when `--repo` is omitted)

Disposable KB base names are **not** configured here — `eval-run.mjs` defaults `--base` to the run folder name (`<repo-leaf>-YYYY-MM-DD-HHmm`, same string as `~/.kb/evaluations/<that>/`). Override with `--base` if needed.
