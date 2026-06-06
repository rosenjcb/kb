# TICKET-003: LLM Jury Semantic Loss (`L_jury`)

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, correctness, llm-judge

## Context

Structural AST matching catches syntactic errors but cannot evaluate semantic correctness: does the logic do what the task asked? This requires language model evaluation. However, a single LLM judge is unreliable — it will approve incorrect code (low True Negative Rate) and be influenced by response length. This ticket implements a multi-judge ensemble with a minority-veto policy to produce a calibrated semantic loss score.

## Objective

Implement an ensemble jury system that:
1. Sends candidate output `Y` to `K` distinct LLM judges against an atomic rubric.
2. Applies minority-veto: if `V` or more judges flag a veto, the overall score is failed regardless of the majority.
3. Returns a normalized semantic loss in `[0, 1]`.

## Acceptance Criteria

- [ ] Accepts a candidate string `Y`, reference string `Y*`, and a rubric `R = [r_1, ..., r_D]` where each item is a string claim.
- [ ] Queries at least `K = 3` distinct model families (e.g., Claude, GPT-4o, and one open-weight model).
- [ ] Each judge grades each rubric item on a 0–5 scale via the meta-prompt template (see Implementation Notes).
- [ ] Minority-veto: if `V >= 2` judges emit `"veto_flag": true`, the run receives `L_jury = 1.0` regardless of scores.
- [ ] Without veto, `L_jury = 1 - (mean_score / 5.0)` averaged across rubric items and judges.
- [ ] Judge responses are validated as JSON before scoring; malformed responses are treated as veto.
- [ ] Unit tests cover: all judges agree, one judge vetoes, malformed JSON response, all rubric items score 5 → loss = 0.

## Implementation Notes

### Meta-Prompt Template

```
You are an expert software engineering judge evaluating a codebase patch.

Step 1: List all functional requirements from the task specification.
Step 2: Examine the candidate output step-by-step for logic errors, missing imports, and hallucinated facts.
Step 3: Grade each rubric item from 0 to 5:
  - 0: Complete failure
  - 1-2: Major bugs present
  - 3-4: Minor issues, logic correct
  - 5: Perfect compliance

Rubric items:
{rubric_items}

Candidate output:
{candidate}

Reference output:
{reference}

Respond ONLY in valid JSON:
{
  "analysis": "<step-by-step reasoning>",
  "scores": {"rubric_1": <int>, ...},
  "veto_flag": <bool>,
  "veto_reason": "<string or empty>"
}
```

### Model Family Diversity

Use different provider SDKs so that self-enhancement bias (a judge favoring its own model family's output style) is distributed across the ensemble. Do not use the same underlying model for both generation and judging.

### Rubric Design

Rubric items must be atomic and verifiable — one claim per item. Avoid compound claims. Each item should be falsifiable from the candidate text alone.

## Output Artifact

`eval/losses/jury_loss.py`  
`eval/prompts/judge_meta_prompt.txt`

## Dependencies

TICKET-001

## Feeds Into

TICKET-006, TICKET-007, TICKET-008
