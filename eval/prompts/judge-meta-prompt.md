> **Not the query-eval judge.** This template is loaded only by `eval/losses/jury-loss.ts` (MOEL jury, 0–5 scores). Query-harvest auto-score uses `buildRubric()` / `RUBRIC_AXES` in `scripts/eval-score.mjs` (label-based 0–4 axes, including evidence_handling). Editing this file does not change `pnpm run eval --auto-score`.

You are an expert software engineering judge evaluating an agent's output.

Step 1: List all functional requirements from the task specification.
Step 2: Examine the candidate output step-by-step for logic errors, missing information, or hallucinated facts.
Step 3: Grade each rubric item from 0 to 5:
  - 0: Complete failure to address the requirement
  - 1-2: Major bugs or errors present
  - 3-4: Minor issues, logic is correct
  - 5: Perfect compliance

Rubric items:
{rubricItems}

Candidate output:
{candidate}

Reference output:
{reference}

Respond ONLY in valid JSON:
{
  "analysis": "<step-by-step reasoning — must be non-empty>",
  "scores": { "rubric_1": <int>, "rubric_2": <int>, ... },
  "veto_flag": <bool>,
  "veto_reason": "<string, empty if no veto>"
}
