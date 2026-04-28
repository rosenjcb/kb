---
name: kb-evaluation-run
description: "Use when: running the reusable KB evaluation scenario (canonical raylib, kb dogfood self-check, or any repo via suite `repo_url`/`--repo`), scoring `kb query`, and writing artifacts under `~/.kb/evaluations/<run-name>/` per `EVALUATION.md`."
---

# KB Evaluation Run

Use this skill when the user wants a repeatable evaluation run of the `kb` system.

Canonical spec: `EVALUATION.md`

Do not invent a new scenario or JSON shape. Follow `EVALUATION.md` as the source of truth.

## Evaluation target

**Primary external benchmark:** suite `raylib` (repo resolves from suite YAML `repo_url`; optional `--repo` override).

**Kb self-check:** suite `kb` (repo resolves from suite YAML `repo_url`; optional `--repo` override). Different questions from raylib.

**Any other upstream:** suite `generic` + `--repo <git-url>`.

- Default disposable **KB base** = **run folder basename** (`<repo-leaf>-YYYY-MM-DD-HHmm`, e.g. `raylib-2026-04-27-1303`); same as `~/.kb/evaluations/<run-name>/`. Override with `--base`.
- `kb init` cwd = snapshot clone under `~/.kb/evaluations/<run-name>/repo/`
- No publish step inside eval-run (artifacts only)
- Artifact: `~/.kb/evaluations/<run-name>/artifact.json` by default

## Canonical question set (raylib)

Use these eight questions unchanged for `--suite raylib`:

1. What is raylib for, and what are its main capabilities?
2. How does raylib's architecture work, including modules and platform support?
3. How do I install and build raylib, including dependencies and build systems?
4. What configuration options and compile flags does raylib support?
5. How does raylib handle graphics backends and platform-specific rendering?
6. What are the coding conventions and style guidelines for contributing to raylib?
7. What are the main gotchas, constraints, and known limitations of raylib?
8. What does the raylib roadmap say about future plans, and what is the recent version history?

## Automated runner (single entry)

From kb repo root (`pnpm run build` first):

```bash
# Canonical raylib disposable run + optional auto-score
npm run eval:all -- --suite raylib [--auto-score]

# Re-query only (existing base; no init)
npm run eval:query -- --suite raylib --base <base> [--auto-score]

# Kb repo dogfood questions (not the raylib benchmark)
npm run eval:all -- --suite kb [--auto-score]

# Any git URL → shallow clone → init → generic eight questions
npm run eval:all -- --suite generic --repo https://github.com/org/repo.git [--auto-score]
```

Implementation: `scripts/eval-run.mjs` (modes `all` | `query`, suites `raylib` | `kb` | `generic`). Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override.

Flags: `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--skip-init`, `--hypothesis`, `--label`. See `EVALUATION.md` § Automated harvest.

Artifacts default under `~/.kb/evaluations/<run-name>/`.

### Manual equivalent (debug only)

```bash
npm run refresh:global
cd ~/raylib
kb init --base ci-raylib-YYYYMMDD --non-interactive
kb logs list --command init --limit 3
kb docs list --base ci-raylib-YYYYMMDD --output json
kb graph --base ci-raylib-YYYYMMDD
kb query "<Q1>" --base ci-raylib-YYYYMMDD --output json   # repeat x8
kb publish jekyll --base ci-raylib-YYYYMMDD --dir ~/raylib-kb-docs/ --apply
```

## Auto-scoring

`--auto-score` needs `GEMINI_API_KEY` or `OPENAI_API_KEY`. Or `--scores-file` with eight `{ correctness, usefulness, specificity, evidence_handling, notes }` objects (axes 0–4 per `EVALUATION.md`).

## Artifact rule

Always write the artifact, even for weak or partial runs.

- Everything captured → `status: "complete"`
- Something missed → `status: "partial"`
- Store the JSON under `evaluation/runs/`; do not treat `tmp-*` scratch trees as the artifact

## JSON rule

Use the schema in `EVALUATION.md`. Minimum:

1. Keep the exact top-level structure.
2. Keep the same question ordering (per suite).
3. Include raw outputs when practical.
4. If a field is unavailable, use `null` and explain why in a sibling `*_note` field.

## Jekyll publish

Not part of eval-run. Keep eval artifacts only; publish flows run separately.

## Output paths

- Spec: `EVALUATION.md`
- Artifacts: `evaluation/runs/*.json` (default: not in git — see `EVALUATION.md` § Artifact Storage)
- Raylib docs site: `~/raylib-kb-docs/`

## Notes

- `EVALUATION.md` is singular. If the user says `EVALUATIONS.md`, treat it as `EVALUATION.md`.
- Keep `ci-raylib-*` / disposable bases ephemeral; never pollute `dogfood`.
- A low score is a valid result — comparability over optics.
- Reference baseline: `evaluation/runs/2026-04-19-raylib-baseline.json` (pass rate 0.50, 14 docs, 404 entities).
