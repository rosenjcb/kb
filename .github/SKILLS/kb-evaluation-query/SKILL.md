---
name: kb-evaluation-query
description: "Formerly kb-evaluation-run. Use when: running the reusable KB query/answer-quality evaluation scenario, rebuilding a disposable KB from scratch, scoring `kb query` and `kb chat`, and writing a run artifact under `evaluation/runs/` using the schema defined in `EVALUATION.md`. For full task-execution evals (solving a real GitHub issue with vs without kb), see kb-evaluation-task / `TASK_EVALUATION.md` instead."
---

# KB Evaluation: Query (formerly KB Evaluation Run)

Use this skill when the user wants a repeatable evaluation run of the `kb` system.

Canonical spec:

- `EVALUATION.md`

Do not invent a new scenario or JSON shape. Follow `EVALUATION.md` as the source of truth.

## Repeatable automated harvest (repo script)

For a **non-TUI** pass that still follows the canonical question set and `evaluation/runs/` schema:

1. From the repo root: `pnpm run build`
2. Run: `npm run eval:kb-proper -- --base ci-eval-YYYYMMDD-<label> [--label <artifact-slug>] [--hypothesis "..."] [--workdir /tmp/kb-eval-...]`

The runner is `scripts/eval-kb-proper.mjs`. It runs `kb init --non-interactive`, sets the disposable base as default, captures `docs list`, `graph`, `logs list`, and eight `kb query … --output json` calls, then writes `evaluation/runs/YYYY-MM-DD-<label>.json`. The child process **unsets `KB_HOME`** so sessions land under the default home (`~/.kb/...`) unless you intentionally export `KB_HOME` in the parent shell in a way the script cannot strip (the script always strips it for reproducibility).

**Chat** is not captured in this batch path: keep `chat_evaluation` as `status: "not_captured"` with notes, or run Phase 3 from `EVALUATION.md` manually afterward.

**Rubric scores** default to `0` with a note to fill manually. After reviewing the query JSON, either edit the artifact or re-run with `--scores-file` pointing at a JSON array of eight objects `{ "correctness", "usefulness", "specificity", "evidence_handling", "notes" }` (each axis `0`–`4` per `EVALUATION.md`).

Use `--skip-init` with an existing `--workdir` to rebuild only the artifact from saved `init.log`, `docs.json`, `graph.txt`, `logs.txt`, and `q1.json`…`q8.json`.

## Goal

Run the same end-to-end scenario on a fresh disposable base so results can be compared across agents, branches, or workflow variants.

## Required Workflow

1. Refresh and verify the CLI from the repo root:
   - `npm run refresh:global`
   - `command -v kb`
2. Use a disposable base:
   - `ci-eval-YYYYMMDD-<label>`
3. Start the real interactive TUI:
   - `kb`
4. Run:
   - `/init --base <ci-base>`
5. Let init finish through `pass-graph`.
6. Capture KB state:
   - docs written
   - graph summary
   - init telemetry if available
7. Run the canonical question set from `EVALUATION.md` through:
   - `kb query "<question>" --base <ci-base> --output json`
   - `kb chat`
8. Score answers using the rubric in `EVALUATION.md`.
9. Write the artifact to:
   - `evaluation/runs/YYYY-MM-DD-<label>.json`
10. **Optional dogfood:** If the evaluation informs merge-bound decisions, document findings in the artifact and PR.

## Scenario

This skill is for exactly this scenario:

1. Run `kb` and then interactive `/init` from the repo root.
2. Build the KB from scratch, including graph extraction.
3. At the end, ask codebase/project questions with `kb query` and `kb chat`.
4. Score correctness and usefulness across broad topic areas such as:
   - architecture
   - project overview
   - contributor workflow
   - configuration
   - retrieval and graph internals
   - testing and validation
   - repo-specific KB process rules

## Artifact Rule

Always write the result artifact, even if the run is weak or incomplete.

- If everything was captured, mark `status` as `complete`.
- If some surface was missed, mark `status` as `partial`.
- Do not skip artifact creation just because the results are bad.

## JSON Rule

Use the schema in `EVALUATION.md`.

Minimum rule:

1. Keep the exact top-level structure documented there.
2. Keep the same question ordering.
3. Include raw outputs when practical.
4. If a field is unavailable, use `null` and explain why in a note field.

## Output Paths

- Plan/spec: `EVALUATION.md`
- Run artifacts: `evaluation/runs/`

## Notes

- `EVALUATION.md` is singular. If a user says `EVALUATIONS.md`, treat that as referring to `EVALUATION.md` unless they explicitly rename the file.
- Do not pollute dogfood or default bases with evaluation traffic; use `ci-*`.
- A low score is still a valid result. The purpose is comparability, not making the system look good.
