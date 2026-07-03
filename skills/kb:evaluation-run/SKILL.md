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
pnpm run eval -- --suite raylib [--auto-score]

# Kb repo dogfood questions
pnpm run eval -- --suite kb [--auto-score]

# Control baseline (Condition N) runs side-by-side with kb BY DEFAULT: the SAME questions
# answered by a real agent (Claude Code, no kb) exploring the clone. Both land in one artifact.
pnpm run eval -- --suite raylib --skip-control   # opt out → kb-only artifact

# Any git URL → shallow clone → init → generic eight questions
pnpm run eval -- --suite generic --repo https://github.com/org/repo.git [--auto-score]

# Conversational chat eval: init + 3 scenarios + retrieval scoring
pnpm run eval:chat -- --base <name> --cwd <repo-path>
```

Implementation: `scripts/eval-run.mjs` (suites `raylib` | `kb` | `generic`). Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override.

Flags: `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--hypothesis`, `--label`. See `EVALUATION.md` § Automated harvest.

Artifacts default under `~/.kb/evaluations/<run-name>/`.

## Control baseline (Condition N) — `scripts/control-core.mjs`, a phase of `eval`

The control is the workflow kb is measured against: a **real coding agent (Claude Code headless), no kb**, answering
the same suite questions by exploring the clone itself. It runs **by default inside `pnpm run eval`** (not a separate
command) — pass `--skip-control` to opt out. It scores with the **same rubric/judge** as `kb query`. The single
`artifact.json` holds kb at top level (`run.condition = "kb"`), a `control` block (its own `aggregate_scores` +
`control_telemetry` tokens/turns/cost), and a `comparison` block (kb-minus-control deltas); with `--skip-control` those
keys are absent. The agent runs with `--bare --strict-mcp-config` so no MCP/kb tools load. Knobs: `--control-model`,
`--control-max-turns`, `--control-prompt` (`KB_CONTROL_PROMPT`, must contain `{{question}}`), `--control-agent-cmd`
(`KB_CONTROL_AGENT_CMD`, e.g. Cursor). The trends summary separates control-vs-kb rows and prints deltas. See
`EVALUATION.md` § The Control.

## Headline grade: kb vs control (ΔS)

The project verdict is **`artifact.comparison.success_score.delta_kb_minus_control`** from a single eval run with both phases:

```bash
pnpm run eval -- --suite kb --auto-score    # → ΔS in artifact + end summary
```

| ΔS | Verdict |
|----|---------|
| ≥ +0.02 | kb ahead of control |
| ≤ −0.02 | kb behind control |
| else | on par |

`--skip-control` omits `control`/`comparison` — use only for kb-side iteration; no ΔS.

Full spec: `EVALUATION.md` § Headline verdict.

## Secondary: trends summary (regression tracking)

Every `pnpm run eval` run **ends with an automatic trends summary** listing prior runs
for the suite (structural metrics + score columns) — there is no separate `eval:trends`
script. Use that summary to spot kb-side regressions — **not** as the headline
kb-vs-control comparison (that requires ΔS from one artifact).

Columns: `date | run | docs | ent | rels | res | success | pass | corr | use`

After every eval run, copy the artifact to `evaluation/runs/<label>.json` so it stays visible to future runs' trend summaries.

## Question sets

Questions are defined in `eval/suites/<suite>.yaml`. The kb and raylib suites include a mix of conceptual and code-structure questions:

**kb suite** — includes questions that specifically test code-graph traversal (IMPORTS_FILE, EXPORTS_SYMBOL edges) e.g. "Which source files import TsMorphIndexer?" These require the `code-graph` cycle to have run and the semantic bridge to be populated.

**raylib suite** — includes structural questions about module dependencies and file relationships that test what the semantic graph captured about the C codebase.

Do not hardcode question text in prompts or scripts — always load from the YAML.

## Auto-scoring

`--auto-score` needs `GEMINI_API_KEY` or `OPENAI_API_KEY`. The judge picks a descriptive **label** per axis (e.g. `mostly_correct`), each mapping to an ordinal `0–4` level. Or `--scores-file` with eight `{ correctness, usefulness, relevance, specificity, evidence_handling, notes }` objects — each axis a rubric label or an equivalent raw `0–4` level per `EVALUATION.md`.

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

## Publish

Not part of eval-run. Keep eval artifacts only; publish flows run separately.

## Output paths

- Spec: `EVALUATION.md`
- Artifacts: `evaluation/runs/*.json` (default: not in git — see `EVALUATION.md` § Artifact Storage)

## Notes

- `EVALUATION.md` is singular. If the user says `EVALUATIONS.md`, treat it as `EVALUATION.md`.
- Keep `ci-raylib-*` / disposable bases ephemeral; never pollute `dogfood`.
- A low score is a valid result — comparability over optics.
- Reference baseline: `evaluation/runs/2026-04-19-raylib-baseline.json` (pass rate 0.50, 14 docs, 404 entities).
