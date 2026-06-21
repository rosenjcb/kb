---
type: "Evaluation Plan"
title: "KB Evaluation Plan"
description: "How KB measures whether a maintained knowledge base materially improves real development work versus a raw coding agent."
resource: ./eval
tags: [evaluation, methodology, scoring]
timestamp: 2026-06-20T00:00:00Z
---

# KB Evaluation Plan

## Goal

Evaluate whether building and maintaining a `kb` knowledge base is materially useful for real development work, and whether a split workflow works better:

- Agent A builds the product/codebase.
- Agent B maintains and refreshes the knowledge base.

The core hypothesis is that this produces better systems faster, with lower token cost, better requirement capture, and better recall of project knowledge than relying on the primary coding agent's transient context alone.

## Primary Question

After building a KB from scratch for the evaluation target repository, can `kb` answer important questions about the project accurately and usefully enough to justify the extra maintenance work?

## Secondary Questions

1. Does `kb init` produce a usable knowledge base from the current repo without manual surgery?
2. Does the resulting KB support retrieval-style questions (`kb query`) accurately across multiple topic areas?
3. Is the resulting graph store populated enough to plausibly improve retrieval?
4. What is the cost of producing this KB in time, tokens, and operator effort?
5. In a later comparison run, does a dedicated KB-maintenance agent improve outcomes versus a single-agent baseline?

## Evaluation Target

**Canonical external benchmark:** the [raylib C library](https://github.com/raysan5/raylib) — use suite `raylib` (its `repo_url` is defined in `eval/suites/raylib.yaml`; override with `--repo` only when needed).

Reasons: mature, well-documented, not kb itself (avoids evaluator familiarity bias), rich graph structure, stable upstream.

**Kb self-check:** suite `kb` (its `repo_url` is defined in `eval/suites/kb.yaml`; override with `--repo` only when needed). That is a product smoke test, not the primary raylib benchmark.

For day-to-day kb architecture work on your checkout, use `--base dogfood` (separate from disposable eval bases).

### Base naming convention

| Base | Purpose | Lifetime |
|------|---------|----------|
| `eval-{suiteId}` | **Default** session for `eval-run.mjs`: e.g. `eval-raylib`, `eval-kb`. Created once and reused across runs. Override with `--base`. | Semi-permanent |
| `raylib` | Persistent agent comparison base — accumulates across tasks, never wiped | Permanent |
| `dogfood` | kb's own architectural knowledge | Permanent |

The `eval-{suiteId}` base is created automatically on first run and reused on subsequent runs. This means query quality improves over time as the session accumulates facts. Use `--force-init` to wipe and re-init the session from scratch if needed.

The `raylib` base is the KB that a KB-backed agent uses during real development work. Do not confuse it with `eval-raylib` — `raylib` accumulates task results, `eval-raylib` is the eval benchmark session.

### Published docs location

Eval runs do **not** publish Jekyll output. We only capture init/query evidence artifacts.

## Automated harvest (`scripts/eval-run.mjs`)

One runner drives all eval runs. Session lifecycle is fully automatic:

1. Base is derived as `eval-{suiteId}` (e.g. `eval-raylib`).
2. If the session already has docs → reuse it (query-only run).
3. If the session is empty / missing → run `kb init` first.
4. **Always** run `kb scan --non-interactive` on the snapshot clone (refresh facts/tombstones), then query.
4. After writing `artifact.json`, prints a **kb vs control** summary for this run (`success_score`, ΔS, verdict). A secondary trends table lists prior runs for the same suite (diagnostic only — not the headline comparison).

**Quick start** (from kb repo root, after `pnpm run build`):

```bash
# Standard run — auto-manages session, ends with trends:
pnpm run eval -- --suite raylib

# With LLM auto-scoring:
pnpm run eval -- --suite raylib --auto-score

# Force re-init even if session exists:
pnpm run eval -- --suite raylib --force-init

# Override session name:
pnpm run eval -- --suite raylib --base my-custom-session
```

| npm script | Maps to |
|------------|---------|
| `pnpm run eval -- --suite raylib` | 8× query eval against `eval-raylib`, then trends |
| `pnpm run eval -- --suite kb` | Self-check against `eval-kb` |
| `pnpm run eval -- --suite generic --repo <git-url>` | Any repo (requires explicit `--repo`) |

**Suites (`--suite`)**

- `raylib` — Eight raylib-specific questions.
- `kb` — Eight kb-repo / product questions (contributor dogfood).
- `fzf` — Eight fzf-specific questions.
- `generic` — Eight repo-neutral questions. Use with `--repo` for arbitrary upstreams.

Override questions with `--questions-file path.json` (JSON array of exactly eight strings).

**Artifacts**

- Default path: **`~/.kb/evaluations/<run-name>/artifact.json`**. Override with `--out`.
- Rebuild artifact from existing scratch: `--skip-init --run-dir ~/.kb/evaluations/<run-name>/`.
- Automated artifacts may include extra `run` fields for traceability. Tools should treat unknown keys as forward-compatible metadata.

## The Control (Condition N): a real agent, no KB

The honest question for `kb` is not "does it improve over previous `kb` runs?" but "does it beat the workflow people
use today?" — *a real coding agent exploring the codebase by itself, with no outsourced knowledge base.* That is the
**control**, and it is the baseline every `kb` (Condition **K**) result should be reported against.

The control is a real agent, not a simulation, and it runs **as a phase of `pnpm run eval`** — kb and control go
side-by-side into **one unified artifact**. After the kb queries, eval clones nothing extra: it reuses the same repo
snapshot and hands each suite question to **Claude Code running headless** inside that clone, with **no KB and no MCP**
(`--strict-mcp-config`), so it must explore raw files with its own `Read`/`Grep`/`Glob`/`Bash` tools. Answers
are scored by the **same rubric and the same judge** as `kb query`, and per-question agent telemetry (tokens, turns,
cost) is captured so the comparison covers both **quality and efficiency**.

```bash
# kb + control side-by-side into one artifact.json (control runs by default)
pnpm run eval -- --suite raylib --auto-score

# kb only — control omitted; no ΔS verdict (use for kb-side iteration only)
pnpm run eval -- --suite raylib --auto-score --skip-control
```

Per-question, the comparison is literally `kb query "Q"` vs the *same* `Q` handed to Claude (`claude -p "<prompt> Q"`).
A single `~/.kb/evaluations/<run>/artifact.json` holds both: the kb results at top level (`run.condition = "kb"`), the
control under a `control` block (with its own `aggregate_scores` + `control_telemetry`), and a `comparison` block of
kb-minus-control deltas. With `--skip-control` the `control`/`comparison` keys are absent — **there is no headline grade
for that run**.

The end-of-run summary prints **this run's** kb vs control row first (when both phases ran). The trends table below is
for regression tracking only; do not treat kb-vs-kb historical deltas as the project verdict.

Because the control runs by default, eval **preflights the agent and fails fast**: if the chosen agent binary is not on
PATH (`claude` by default, `agent` for Cursor), the run exits immediately — *before any clone or `kb init`* — with a
clear message telling you to install the agent or re-run with `--skip-control`. It never silently does the kb work and
then discovers the agent is missing.

Knobs (all optional):

- `--control-agent claude|cursor` (env `KB_CONTROL_AGENT`) — built-in backends. Default: `claude` (Claude Code).
  `cursor` uses the Cursor Agent CLI (`agent -p --mode ask --trust`, read-only headless).
- `--control-model <id>` pins the agent model (e.g. `claude-opus-4-8`, `composer-2.5`).
- `--control-max-turns N` caps exploration per question (**claude only**).
- `--control-prompt` (env `KB_CONTROL_PROMPT`) tunes the wrapper prompt — must contain `{{question}}`.
- `--control-agent-cmd` (env `KB_CONTROL_AGENT_CMD`) **fully overrides** `--control-agent`; prompt on stdin, JSON on stdout.

> The control supersedes the legacy `eval/tools/filesystem-tools.ts` toy tools, which only approximated Condition N and
> were never wired into a runner. The control logic lives in `scripts/control-core.mjs` and runs inside `eval-run.mjs`.

## Evaluation Design

This evaluation should be run at least twice against the same codebase snapshot or equivalent branch state:

1. Baseline run:
   - Build the KB from scratch with the normal workflow.
   - No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately.
2. Comparison run:
   - Repeat on a fresh disposable base after using the intended two-agent workflow.
   - Keep the question set, scoring rubric, and artifact schema identical.

## Standard Procedure

### Phase 1: Run the Eval

```bash
# Headline grade (kb + control → ΔS in artifact.comparison):
pnpm run eval -- --suite kb --auto-score

# Kb-side iteration only (no ΔS):
pnpm run eval -- --suite kb --auto-score --skip-control
```

Every run: `kb scan` on the snapshot clone, then 8× `kb query` (one-shot synthesis — see
`src/core/QUERY_INTERNALS.md`), then control (unless skipped).

To force a fresh init (e.g. after significant KB changes): `--force-init`.

### Phase 2: Review Artifacts

Artifacts land in `~/.kb/evaluations/<run-name>/artifact.json`. Fields to check:

- `run.init_result.written_docs` — docs created (only relevant when init ran)
- `run.init_result.graph_summary.entities` / `.relationships`
- `aggregate_scores.query.mean_usefulness`
- `aggregate_scores.query.pass_rate_correctness_and_usefulness_at_least_3`

### Phase 3: Score the Results

Each question gets a rubric score on four axes. Use `--auto-score` for LLM judging (requires `GEMINI_API_KEY` or `OPENAI_API_KEY`), or supply a `--scores-file` for manual scoring.

The scorer is called **3 times by default** and the numeric axes are averaged (`--score-runs 3`). Single-shot Gemini scores have ~1 point of noise per question; averaging across 3 calls reduces run-to-run variance enough to make inter-run comparisons meaningful. Pass `--score-runs 1` to cut costs when you only need a rough signal.

## Canonical Question Set

Use these raylib-adapted questions for all runs. If revised, copy the old suite forward and record the change in the artifact.

1. What is raylib for, and what are its main capabilities?
2. How does raylib's architecture work, including modules and platform support?
3. How do I install and build raylib, including dependencies and build systems?
4. What configuration options and compile flags does raylib support?
5. How does raylib handle graphics backends and platform-specific rendering?
6. What are the coding conventions and style guidelines for contributing to raylib?
7. What are the main gotchas, constraints, and known limitations of raylib?
8. What does the raylib roadmap say about future plans, and what is the recent version history?

## Scoring Rubric

Score each answer on four axes from `0` to `4`.

### Correctness

- `4`: Factually correct and grounded in the repo/KB.
- `3`: Mostly correct with minor omissions.
- `2`: Mixed; contains meaningful inaccuracies or unsupported inference.
- `1`: Mostly wrong or misleading.
- `0`: No useful answer.

### Usefulness

- `4`: Directly helps a developer act or understand the system.
- `3`: Helpful but incomplete.
- `2`: Some signal, but requires substantial follow-up.
- `1`: Barely helpful.
- `0`: Not helpful.

### Specificity

- `4`: Uses concrete repo-specific details, commands, or mechanisms.
- `3`: Some concrete detail, but still generic in places.
- `2`: Partly generic.
- `1`: Mostly generic.
- `0`: Purely generic or evasive.

### Evidence Handling

- `4`: Clearly constrained to evidence, acknowledges uncertainty appropriately.
- `3`: Reasonably evidence-grounded.
- `2`: Some speculation or weak grounding.
- `1`: Strong speculation or unsupported claims.
- `0`: No evidence discipline.

## Headline verdict: kb vs control (ΔS)

The **single scalar grade** for whether kb beats the real-agent baseline is the
**success-score delta** from the same artifact:

```
ΔS = success_score_kb − success_score_control
     = artifact.comparison.success_score.delta_kb_minus_control
```

Both sides answer the **same eight questions**, are scored by the **same judge** (Gemini/OpenAI,
`--score-runs 3` by default), and are graded with the **same** `success_score` formula and
budgets. This is the harvest pipeline's MOEL-aligned headline metric: one number that blends
quality, token economy, and speed (see below).

| ΔS | Verdict (`kbControlVerdict`) |
|----|------------------------------|
| ≥ +0.02 | **kb ahead of control** |
| ≤ −0.02 | **kb behind control** |
| otherwise | **on par with control** |

Read the full breakdown in `artifact.comparison` — each axis has `{ kb, control, delta_kb_minus_control }`
for `success_score`, `quality_score`, `token_efficiency`, `speed_score`, pass rate, and rubric means.
The per-component deltas show *where* kb wins or loses (e.g. higher quality but slower control).

**Requires both phases.** Run `pnpm run eval -- --suite <name> --auto-score` without `--skip-control`.
Kb-only runs still record `aggregate_scores.query.success_score` but cannot emit ΔS.

## Success Score (primary metric)

`success_score` (also written **S** in the research paper) is the per-side scalar in `[0, 1]` (higher is better) that
blends answer quality, token economy, and speed:

```
success = 0.60 · quality + 0.30 · token_efficiency + 0.10 · speed
```

| Component | Weight | Definition |
|-----------|--------|------------|
| `quality` | 60% | `(mean_correctness + mean_usefulness) / 8` — both axes are `0–4`, so their sum maps to `[0, 1]`. |
| `token_efficiency` | 30% | `1 − min(weighted_tokens / token_budget, 1)` — weighted total for the 8-question run: `input + output + 0.1 × cache_read` (cache discount matches MOEL / Anthropic prompt caching). kb query logs undifferentiated input+output; control agents report cache reads separately. |
| `speed` | 10% | `1 − min(total_duration_ms / time_budget, 1)` — total wall-clock for the 8-question run. |

**Budget-absolute normalization.** Token and speed sub-scores are measured against
fixed budgets (not relative to control), so a run's score is stable across
comparisons. Defaults (tunable in `scripts/eval-shared.mjs`):

- `token_budget = 1,000,000` tokens per 8-question run
- `time_budget = 600,000` ms (10 min) per 8-question run

Both the kb run and the control run are scored with the **same** formula and budgets,
so `success` is directly comparable head-to-head. When token/speed telemetry is
missing (e.g. an old quality-only artifact), `success_score` is `null` rather than
a partial number.

## Aggregate Metrics

For each run, compute and record:

- `success_score` (primary) plus its `quality_score`, `token_efficiency`, `speed_score` parts
- Mean score per axis for `query` (`correctness`, `usefulness`, `specificity`, `evidence_handling`)
- Pass rate where `correctness >= 3` and `usefulness >= 3` (secondary/diagnostic)
- KB and control token/latency telemetry (`kb_query_telemetry`, `control_telemetry`)
- Coverage notes by topic area

## Success Thresholds

Treat a run as promising if all are true:

1. `kb init` completes successfully on a fresh disposable base.
2. The graph store is populated with non-zero entities and relationships.
3. `success_score >= 0.70`.
4. At least `6/8` questions score `correctness >= 3`.
5. At least `6/8` questions score `usefulness >= 3`.

Treat kb as **ahead of the real-agent baseline** when `comparison.success_score.delta_kb_minus_control ≥ 0.02`
(equivalently: kb's `success_score` beats control's by at least 0.02 in the same artifact). The per-component
deltas in `artifact.comparison` show *where* the win or loss comes from.

## Artifact Storage

Every run — even weak or partial ones — should still **emit** a JSON artifact so comparisons stay reproducible. Default layout: `evaluation/runs/YYYY-MM-DD-<label>.json`. The repo **gitignores `evaluation/`** by default, so these files are not part of normal commits unless you force-add or change ignore rules.

Filename convention: `evaluation/runs/YYYY-MM-DD-<label>.json`

Reference baseline (historical example path): `evaluation/runs/2026-04-19-raylib-baseline.json`

## Artifact Format

Each artifact should include:

- Run metadata
- Init metrics
- KB state summary
- Full question set used
- Raw `kb query` outputs
- Raw `kb chat` outputs (or `not_captured`)
- Manual rubric scores
- Aggregate scores
- Qualitative notes

## Required JSON Schema

Future agents should treat the JSON shape below as the canonical artifact format. The goal is repeatability across runs even when the agent does not have prior conversational context.

### Required top-level fields

- `schema_version`
- `evaluation_plan`
- `run_label`
- `status`
- `created_at`
- `repository`
- `hypothesis`
- `run`
- `question_set`
- `query_evaluation`
- `chat_evaluation`
- `kb_query_telemetry` (v2: kb-side token/latency totals; mirrors `control_telemetry`)
- `success_score_inputs` (v2: the raw values fed to the composite, including budgets)
- `aggregate_scores`
- `qualitative_findings`
- `next_improvement_areas`
- `control` (when control phase ran — condition N scores + telemetry)
- `comparison` (when control phase ran — **headline ΔS** and per-axis kb−control deltas)

### Field expectations

- `schema_version`: integer schema version (currently `2`; v2 adds `success_score` + telemetry)
- `evaluation_plan`: string path, usually `EVALUATION.md`
- `run_label`: short label like `raylib-baseline` or `raylib-compare-agent-b`
- `status`: `complete` or `partial`
- `created_at`: ISO-8601 timestamp
- `repository`: object with `name`, `branch`, `commit`
- `hypothesis`: short string describing what this run is testing
- `run`: object describing the concrete scenario execution
- `question_set`: ordered array of the exact questions used
- `query_evaluation`: ordered array with one item per question
- `chat_evaluation`: ordered array with one item per question, or an object with `status: "not_captured"` plus `notes` if chat was not captured
- `aggregate_scores`: computed summary metrics
- `qualitative_findings`: flat array of short observations
- `next_improvement_areas`: flat array of likely follow-up improvements

### Required `run` object

The `run` object should contain:

- `base`
- `mode` (string describing capture style, e.g. `non_interactive_cli_init` or `query_only_harvest`)
- `commands`
- `init_result`

Recommended for automated runs (so comparisons stay attributable):

- `eval_mode`: `all` or `query` — whether `kb init` was executed in this capture
- `suite`: `raylib` \| `kb` \| `generic` (or custom label if using `--questions-file`)
- `target_cwd`: absolute path where `kb` commands ran
- `clone_url`: if the target was produced by `git clone`, the URL (else `null`)
- `publish_dir`: Jekyll site root if publish ran (else `null`)
- `workdir`: scratch directory holding `q1.json`…`q8.json` (safe to delete after archiving)

The `init_result` object should contain:

- `status`
- `written_docs`
- `written_doc_ids`
- `init_run_id`
- `init_run_id_note`
- `docs_list`
- `graph_summary`

If a field is unavailable, include it with `null` and explain why in a sibling `*_note` field when appropriate.

### Required per-question shape

Each item in `query_evaluation` and `chat_evaluation` should contain:

- `question_id`
- `question`
- `result_count`
- `retrieval`
- `answer_excerpt`
- `provenance`
- `scores`
- `notes`

The `scores` object must contain:

- `correctness`
- `usefulness`
- `specificity`
- `evidence_handling`

### Raw output capture

To make runs comparable and re-auditable, each per-question object should also include raw command output when practical:

- For query runs: add `raw_query_output`
- For chat runs: add `raw_chat_output`

These may be omitted only if the artifact is marked `partial`.

### Canonical template

```json
{
  "schema_version": 2,
  "evaluation_plan": "EVALUATION.md",
  "run_label": "raylib-baseline",
  "status": "complete",
  "created_at": "2026-04-19T15:00:00-07:00",
  "repository": {
    "name": "raylib",
    "branch": "master",
    "commit": "<git-sha>"
  },
  "hypothesis": "<what this run is testing>",
  "run": {
    "base": "ci-raylib-20260419",
    "mode": "non_interactive_init",
    "commands": [
      "kb init --base ci-raylib-20260419 --non-interactive",
      "kb query '<question>' --base ci-raylib-20260419 --output json (x8)",
      "kb publish jekyll --base ci-raylib-20260419 --dir ~/raylib-kb-docs/ --apply"
    ],
    "init_result": {
      "status": "accepted",
      "written_docs": 0,
      "written_doc_ids": [],
      "init_run_id": null,
      "init_run_id_note": null,
      "docs_list": { "documents": [] },
      "graph_summary": { "entities": 0, "relationships": 0 }
    }
  },
  "question_set": [],
  "query_evaluation": [],
  "chat_evaluation": { "status": "not_captured", "notes": "" },
  "kb_query_telemetry": {
    "questions_answered": 8,
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "total_cost_usd": 0,
    "mean_num_turns": null,
    "total_duration_ms": 0
  },
  "success_score_inputs": {
    "mean_correctness": 0,
    "mean_usefulness": 0,
    "total_tokens": 0,
    "total_duration_ms": 0,
    "token_budget": 1000000,
    "time_budget_ms": 600000
  },
  "aggregate_scores": {
    "query": {
      "success_score": 0,
      "quality_score": 0,
      "token_efficiency": 0,
      "speed_score": 0,
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    },
    "chat": {
      "success_score": null,
      "quality_score": null,
      "token_efficiency": null,
      "speed_score": null,
      "mean_correctness": null,
      "mean_usefulness": null,
      "mean_specificity": null,
      "mean_evidence_handling": null,
      "pass_rate_correctness_and_usefulness_at_least_3": null
    },
    "combined": {
      "success_score": 0,
      "quality_score": 0,
      "token_efficiency": 0,
      "speed_score": 0,
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    }
  },
  "qualitative_findings": [],
  "next_improvement_areas": [],
  "control": {
    "run": { "condition": "control", "suite": "raylib" },
    "aggregate_scores": { "query": { "success_score": 0.812 } },
    "control_telemetry": {
      "questions_answered": 8,
      "total_input_tokens": 0,
      "total_output_tokens": 0,
      "total_cost_usd": 0,
      "mean_num_turns": 0,
      "total_duration_ms": 0
    }
  },
  "comparison": {
    "success_score": {
      "kb": 0.754,
      "control": 0.812,
      "delta_kb_minus_control": -0.058
    },
    "mean_correctness": {
      "kb": 3.113,
      "control": 3.875,
      "delta_kb_minus_control": -0.762
    }
  }
}
```

`control` and `comparison` are present only when the control phase ran (default). The headline project grade is
`comparison.success_score.delta_kb_minus_control` (ΔS).

### Authoring rule

Agents should not invent their own artifact shape for future runs. If the schema needs to change:

1. Update `schema_version`
2. Update this section in `EVALUATION.md`
3. Note the schema change in the artifact itself

## Comparison Guidance

**Primary comparison:** kb vs control in the **same** artifact (`comparison.*.delta_kb_minus_control`).
Do not compare kb run A against control run B from different timestamps unless reproducing a regression.

**Secondary (diagnostics only):** `pnpm run eval:trends -- --suite <name>` lists prior kb and control rows for
the suite. Use trends to spot regressions in kb-side quality or token use — not as the headline verdict.

When comparing two kb-side iterations (e.g. synthesis changes):

1. Keep the snapshot repo at the same git commit when possible.
2. Use `--force-init` or a fresh `--base` if you need a clean index.
3. Reuse the same question set and `--score-runs`.
4. Prefer `--skip-control` for kb-only A/B; run with control periodically to refresh ΔS.

## Threats to Validity

- Repo familiarity may leak into interview answers and inflate results.
- The evaluator may know the correct answers already.
- LLM/provider drift may change answer quality across days.
- A single run can overfit to a lucky or unlucky `init`.
- Query quality may differ from chat quality; both must be measured separately.

## Current Baseline

The reference raylib baseline artifact is:

- `evaluation/runs/2026-04-19-raylib-baseline.json`
- Init: 14 docs, 404 entities, 470 relationships, $0.025, 170s
- Query pass rate: 0.50 (5/8 hybrid retrieval; 1 tokenization-empty miss on install/build query)

That artifact is the reference point for the next comparison run.

---

## Eval Type 2: Agent Token Efficiency Comparison

This is a separate evaluation from the init/query quality eval above. It tests whether having a KB *actually reduces token usage* during real implementation work.

### Hypothesis

A KB-backed agent uses fewer tokens per task than a raw agent — and that advantage **compounds** over a task sequence. Each task the KB-backed agent completes deposits new facts into the `raylib` base. Future tasks find those facts via `kb query` instead of re-reading source files. Per-task token cost decreases as the base densifies.

### Base

Use `--base raylib` (the persistent base, not `ci-*`). This base must survive across task sessions. The compounding effect only manifests when the same base is reused.

```bash
kb use --default raylib    # set once before the task sequence begins
```

### Task sequence (canonical)

Run these in order against `~/raylib/`. Both agents work on the same task; the agent cannot reuse prior-task code between runs.

1. Implement a flappy bird game in `~/raylib/examples/games/flappy_bird.c`
2. Add parallax scrolling background to the flappy bird game
3. Add a high score counter that persists between runs
4. Add sound effects using raylib's audio API

Each task is self-contained enough to run independently (agent starts fresh each time) but thematically connected so KB submissions from earlier tasks are useful to later ones.

### Protocol

**Agent A (raw)**:
- No `kb` access
- Discovers context by reading `~/raylib/src/`, headers, examples, docs directly
- No submissions after the task

**Agent B (KB-backed)**:
- Has `kb query` available, base `raylib`
- Required to run at least one `kb query` before writing code
- May read source files too, but should prefer KB for known facts

### Measurement

Use `codeburn` to capture per-session token counts:

```bash
codeburn report --provider claude --format json > /tmp/codeburn-task-N.json
```

Capture before and after each task. The metric is **tokens consumed per task**, not total.

### Artifact

Store results under `evaluation/runs/agent-compare/YYYY-MM-DD-task-N-<agent>.json`.

Each artifact records:

- `task_id`: 1–4
- `agent`: `raw` or `kb-backed`
- `base`: `null` or `raylib`
- `kb_queries_made`: count (0 for raw agent)
- `kb_submissions_made`: count (0 for raw agent)
- `codeburn_input_tokens`: from codeburn report
- `codeburn_output_tokens`: from codeburn report
- `codeburn_cost_usd`: from codeburn report
- `task_completed`: boolean
- `notes`: free text

### Success criteria

The KB-backed agent hypothesis is supported if:
- Agent B's per-task token cost is lower than Agent A's by task 3 or 4
- Agent B's token cost curve slopes downward across the 4-task sequence
- Agent A's token cost curve is flat or rising

A single session with better task 1 performance does not confirm the hypothesis — the compounding effect is the signal.
