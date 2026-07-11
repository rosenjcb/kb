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

Each file needs: `id`, `rubric_focus`, a non-empty `questions` array, and optionally:
- `repo_url` (default clone URL used when `--repo` is omitted)
- `answers` (same length as `questions`; golden answers for the LLM judge)
- `display_name`

Disposable KB base names are **not** configured here — `eval-run.mjs` defaults `--base` to
`eval-{suiteId}` (reuse across runs). Override with `--base` if needed.

## Suites

| Suite | Repo | Notes |
|-------|------|-------|
| `kb` | this repo | self-check / dogfood |
| `raylib` | raysan5/raylib | primary external C benchmark |
| `fzf` | junegunn/fzf | Go fuzzy finder |
| `kestra` | kestra-io/kestra | Java/UI orchestration (default-10; NiFi-shaped workflows) |
| `shellcheck` | koalaman/shellcheck | Haskell AST linter |
| `lazygit` | jesseduffield/lazygit | Go TUI |
| `datasette` | simonw/datasette | Python explore/publish UI + CLI (default-10) |
| `mitmproxy` | mitmproxy/mitmproxy | Python proxy / TUI |
| `fish-shell` | fish-shell/fish-shell | Rust shell |
| `brew` | Homebrew/brew | Ruby package manager DSL |
| `nifi` | apache/nifi | optional — large; not in `--all-suites` |
| `duckdb` | duckdb/duckdb | optional — large; not in `--all-suites` |
| `generic` | `--repo` required | repo-neutral questions |

## Headline grade (ΔS)

Each suite run (with `--auto-score`, control phase on) produces **`artifact.comparison.success_score.delta_kb_minus_control`** — the single scalar that answers “does kb beat a real agent on this question pack?” Both sides get the same `success_score` formula (quality + tokens + speed). See `EVALUATION.md` § Headline verdict.

```bash
pnpm run eval -- --suite kb --auto-score          # kb + control → ΔS
pnpm run eval -- --suite raylib --auto-score      # primary external benchmark
pnpm run eval -- --suite datasette --skip-control # K-only (control later)
pnpm run eval -- --all-suites                     # 10 default suites (parallel)
```
