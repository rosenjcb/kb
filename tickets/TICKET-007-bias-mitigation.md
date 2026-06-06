# TICKET-007: LLM Judge Bias Mitigation

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, bias, llm-judge

## Context

The LLM jury from TICKET-003 is susceptible to four systematic biases that inflate scores and reduce the signal-to-noise ratio of the evaluation:

1. **Agreeableness bias** — models approve incorrect code; TNR under 25%.
2. **Verbosity bias** — longer responses score higher regardless of correctness.
3. **Position/order bias** — in pairwise comparisons, the first response is systematically preferred.
4. **Self-enhancement bias** — a model prefers outputs from its own model family.

This ticket adds mitigation layers to the jury system to reduce these biases to acceptable levels.

## Objective

Extend the jury system with concrete debiasing mechanisms for all four bias categories. Each mechanism must be independently togglable for ablation studies.

## Acceptance Criteria

### Agreeableness Bias
- [ ] Minority-veto policy is active in the jury (already specified in TICKET-003, but this ticket validates it reduces TNR on the calibration set).
- [ ] "Slow-thinking" meta-prompt is enforced: the judge must produce `"analysis"` reasoning before emitting scores. Responses with an empty `"analysis"` field are treated as malformed.

### Verbosity Bias
- [ ] Rubric items include an explicit conciseness criterion: "Is the response free of unnecessary verbosity?"
- [ ] Scores are normalized by output length: `adjusted_score = raw_score / log(1 + len(candidate_tokens))`. This is applied before aggregation.
- [ ] The normalization factor is configurable (can be disabled for ablation).

### Position/Order Bias
- [ ] For pairwise comparisons (candidate vs. reference), each judge runs the comparison twice with order swapped.
- [ ] Final pairwise score is the average of both orderings.
- [ ] If the two orderings differ by more than 2 points on a 5-point scale, a consistency warning is logged.

### Self-Enhancement Bias
- [ ] The jury ensemble must include models from at least 2 distinct provider families (e.g., Anthropic + OpenAI, or Anthropic + open-weight).
- [ ] The model that generated candidate `Y` is excluded from the jury that evaluates `Y`. The harness tracks which model generated each run.

## Implementation Notes

### Ablation Flags

```python
@dataclass
class BiasConfig:
    enable_slow_thinking: bool = True
    enable_verbosity_normalization: bool = True
    enable_position_debiasing: bool = True
    enforce_model_family_diversity: bool = True
```

These flags are passed to the jury evaluation call so individual mechanisms can be isolated when measuring their contribution to calibration accuracy.

### Measuring Effectiveness

After implementing, run the debiased jury against the 20-task human-annotated calibration set (from TICKET-008) and report TPR and TNR before and after each mechanism. The target is TNR > 70%.

## Output Artifact

`eval/losses/jury_loss.py` (extended from TICKET-003)  
`eval/config/bias_config.py`

## Dependencies

TICKET-003

## Feeds Into

TICKET-008
