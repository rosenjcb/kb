---
layout: default
title: Evaluation
date: '2026-04-18'
kb_id: evaluation-md
tags:
  - source-excerpt
---

# KB Evaluation Plan

## Goal

Evaluate whether building and maintaining a `kb` knowledge base is materially useful for real development work, and whether a split workflow works better:

- Agent A builds the product/codebase.
- Agent B maintains and refreshes the knowledge base.

The core hypothesis is that this produces better systems faster, with lower token cost, better requirement capture, and better recall of project knowledge than relying on the primary coding agent's transient context alone.

## Primary Question

After building a KB from scratch for this repository, can `kb` answer important questions about the project accurately and usefully enough to justify the extra maintenance work?

## Secondary Questions

1. Does `kb init` produce a usable knowledge base from the current repo without manual surgery?
2. Does the resulting KB support both retrieval-style questions (`kb query`) and synthesis-style questions (`kb chat`) across multiple topic areas?
3. Is the resulting graph store populated enough to plausibly improve retrieval and follow-up questioning?
4. What is the cost of producing this KB in time, tokens, and operator effort?
5. In a later comparison run, does a dedicated KB-maintenance agent improve outcomes versus a single-agent baseline?

## Evaluation Design

This evaluation should be run at least twice against the same codebase snapshot or equivalent branch state:

1. Baseline run:
   - Build the KB from scratch with the normal workflow.
   - No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately.
2. Comparison run:
   - Repeat on a fresh disposable base after using the intended two-agent workflow.
   - Keep the question set, scoring rubric, and artifact schema identical.

## Standard Procedure

### Phase 1: Initialize a Fresh KB

From the repo root:

1. Start the TUI with `kb`.
2. Run interactive `/init --base <ci-base-name>`.
3. Let `kb init` complete all passes through `pass-graph`.
4. Save the resulting run metadata and transcript notes.

Use a disposable base name like `ci-eval-YYYYMMDD-<label>` so results do not pollute dogfood data.

### Phase 2: Capture Build Metrics

Collect:

- Base name
- Git branch and commit
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

Run a fixed question set through both surfaces:

- `kb query "<question>" --base <ci-base> --output json`
- `kb chat` against the same base

Questions should span:

1. Project overview / mission
2. Architecture
3. User workflow / CLI usage
4. Configuration / environment
5. Retrieval / graph / indexing internals
6. Testing / validation
7. Operational caveats / gotchas
8. Recent design decisions or repo-specific conventions

### Phase 4: Score the Results

Each question/surface pair gets a rubric score.

For the automated harvest (`npm run eval:kb-proper`), you can either pass **`--scores-file`** with a hand-written JSON array of eight score objects, or **`--auto-score`** / **`--auto-score-file <path>`** to run a single-shot LLM judge over the eight `kb query` JSON outputs (requires `GEMINI_API_KEY` or `OPENAI_API_KEY` in the environment). See `scripts/eval-kb-proper.mjs --help`. Auto scores are a convenience, not a substitute for spot-checking weak answers.

## Canonical Question Set

Use these questions unless there is a strong reason to revise the suite. If revised, copy the old suite forward and record the change in the artifact.

1. What is this project for, and what are the main things `kb` can do?
2. How does `kb init` work at a high level, including the major passes?
3. Where do KB documents live, and how are active/default bases selected?
4. How does retrieval work, including hybrid retrieval and graph involvement?
5. What does `kb chat` do when retrieval is weak or incomplete?
6. What commands should a contributor use during normal dogfood development in this repo?
7. What special repo rules apply to KB documentation and persistence?
8. How can someone inspect the graph and run telemetry/log comparisons?

These questions intentionally mix broad and specific knowledge. A future expansion can add task-oriented prompts like "How do I debug retrieval misses?" or "How do I add a new CLI command safely?"

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

## Aggregate Metrics

For each run, compute:

- Mean score per axis for `query`
- Mean score per axis for `chat`
- Combined mean score
- Pass rate where `correctness >= 3` and `usefulness >= 3`
- Coverage notes by topic area

## Success Thresholds

Treat a run as promising if all are true:

1. `kb init` completes successfully on a fresh disposable base.
2. The graph store is populated with non-zero entities and relationships.
3. Combined pass rate is at least `70%`.
4. At least `6/8` questions score `correctness >= 3`.
5. At least `6/8` questions score `usefulness >= 3`.

Treat the two-agent theory as supported only if the comparison run beats the baseline on at least one of:

- Better combined answer quality
- Lower total token cost
- Lower elapsed time
- Better requirement/process capture in qualitative notes

without causing a meaningful regression in the other categories.

## Artifact Format

Store each run as JSON under `evaluation/runs/`.

Recommended filename:

- `evaluation/runs/YYYY-MM-DD-<label>.json`

Each artifact should include:

- Run metadata
- Init metrics
- KB state summary
- Full question set used
- Raw `kb query` outputs
- Raw `kb chat` outputs
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
- `aggregate_scores`
- `qualitative_findings`
- `next_improvement_areas`

### Field expectations

- `schema_version`: integer schema version, starting at `1`
- `evaluation_plan`: string path, usually `EVALUATION.md`
- `run_label`: short label like `main-baseline` or `worker-agent-b`
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
- `mode`
- `commands`
- `init_result`

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
  "schema_version": 1,
  "evaluation_plan": "EVALUATION.md",
  "run_label": "main-baseline",
  "status": "complete",
  "created_at": "2026-04-17T17:10:00-07:00",
  "repository": {
    "name": "kb",
    "branch": "main",
    "commit": "<git-sha>"
  },
  "hypothesis": "<what this run is testing>",
  "run": {
    "base": "ci-eval-20260417-main-baseline",
    "mode": "interactive_tui_init",
    "commands": [
      "kb",
      "/init --base ci-eval-20260417-main-baseline"
    ],
    "init_result": {
      "status": "accepted",
      "written_docs": 0,
      "written_doc_ids": [],
      "init_run_id": null,
      "init_run_id_note": null,
      "docs_list": {
        "documents": []
      },
      "graph_summary": {
        "entities": 0,
        "relationships": 0
      }
    }
  },
  "question_set": [
    "<question 1>",
    "<question 2>"
  ],
  "query_evaluation": [
    {
      "question_id": 1,
      "question": "<question 1>",
      "result_count": 0,
      "retrieval": {
        "method": null,
        "detail": null,
        "confidence": null
      },
      "answer_excerpt": null,
      "provenance": [],
      "raw_query_output": {},
      "scores": {
        "correctness": 0,
        "usefulness": 0,
        "specificity": 0,
        "evidence_handling": 0
      },
      "notes": ""
    }
  ],
  "chat_evaluation": [
    {
      "question_id": 1,
      "question": "<question 1>",
      "result_count": 0,
      "retrieval": {
        "method": null,
        "detail": null,
        "confidence": null
      },
      "answer_excerpt": null,
      "provenance": [],
      "raw_chat_output": {},
      "scores": {
        "correctness": 0,
        "usefulness": 0,
        "specificity": 0,
        "evidence_handling": 0
      },
      "notes": ""
    }
  ],
  "aggregate_scores": {
    "query": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    },
    "chat": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    },
    "combined": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    }
  },
  "qualitative_findings": [],
  "next_improvement_areas": []
}
```

### Authoring rule

Agents should not invent their own artifact shape for future runs. If the schema needs to change:

1. Update `schema_version`
2. Update this section in `EVALUATION.md`
3. Note the schema change in the artifact itself

## Comparison Guidance

When comparing two runs:

1. Keep the repo state as close as possible.
2. Use fresh `ci-*` bases for both runs.
3. Reuse the same question set and scoring rubric.
4. Prefer the same evaluator, or multiple evaluators with normalized scoring notes.
5. Compare both machine metrics and human judgment.

## Threats to Validity

- Repo familiarity may leak into interview answers and inflate results.
- The evaluator may know the correct answers already.
- LLM/provider drift may change answer quality across days.
- A single run can overfit to a lucky or unlucky `init`.
- Query quality may differ from chat quality; both must be measured separately.

## Current Baseline Execution

The first tracked baseline for this plan is the main-branch run captured in:

- `evaluation/runs/2026-04-17-main-baseline.json`

That artifact should be treated as the reference point for the next comparison run.
