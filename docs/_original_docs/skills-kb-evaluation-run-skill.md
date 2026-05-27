---
layout: default
title: skills/kb:evaluation-run/SKILL.md
date: '2026-05-26'
kb_id: skills-kb-evaluation-run-skill-md
tags:
  - original-source
  - skills-kb-evaluation-run-skill-md
  - kb
categories:
  - reference
---

---
name: kb-evaluation-run
description: "Is the user asking me to run a KB evaluation — the canonical raylib benchmark, the kb dogfood self-check, or a custom repo? Should I score kb query results or write evaluation artifacts under ~/.kb/evaluations/ following EVALUATION.md?"
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

## Automated runner (single entry)

From kb repo root (`pnpm run build` first):

```bash
# Canonical raylib run: clone → init → 8 queries + optional auto-score
npm run eval -- --suite raylib [--auto-score]

# Kb repo dogfood questions
npm run eval -- --suite kb [--auto-score]

# Any git URL → shallow clone → init → generic eight questions
npm run eval -- --suite generic --repo https://github.com/org/repo.git [--auto-score]

# Conversational chat eval: init + 3 scenarios + retrieval scoring
npm run eval:chat -- --base <name> --cwd <repo-path>
```

Implementation: `scripts/eval-run.mjs` (suites `raylib` | `kb` | `generic`). Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override.

Flags: `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--hypothesis`, `--label`. See `EVALUATION.md` § Automated harvest.

Artifacts default under `~/.kb/evaluations/<run-name>/`.

## Comparing runs — always use eval:trends

`npm run eval:trends` is the canonical comparison tool. **Never write ad-hoc Python or bash scripts to compare run results.** It shows structural metrics (docs, entities, relationships, avg query result count) for every run, plus score columns when `--auto-score` was used.

```bash
# Compare all kb suite runs (structural + score trends)
npm run eval:trends -- --suite kb

# Compare all raylib suite runs
npm run eval:trends -- --suite raylib [--limit 10]
```

Output columns: `date | run | docs | ent | rels | res | use | pass | corr | src`

- `docs` — documents written during init
- `ent` / `rels` — semantic graph entities and relationships
- `res` — average query result count (retrieval breadth proxy)
- `use` / `pass` / `corr` — scored axes (populated only when `--auto-score` was used and scores are non-zero)

Score deltas and sparkline trends are printed above the table. Structural deltas (first→latest, prev→latest) are always shown even without scoring.

After every eval run, copy the artifact to `evaluation/runs/<label>.json` so it is visible in `eval:trends --source repo`.

## Question sets

Questions are defined in `eval/suites/<suite>.yaml`. The kb and raylib suites include a mix of conceptual and code-structure questions:

**kb suite** — includes questions that specifically test code-graph traversal (IMPORTS_FILE, EXPORTS_SYMBOL edges) e.g. "Which source files import TsMorphIndexer?" These require the `code-graph` cycle to have run and the semantic bridge to be populated.

**raylib suite** — includes structural questions about module dependencies and file relationships that test what the semantic graph captured about the C codebase.

Do not hardcode question text in prompts or scripts — always load from the YAML.

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
