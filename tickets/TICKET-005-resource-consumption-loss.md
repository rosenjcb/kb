# TICKET-005: Resource Consumption Loss (`L_resource`)

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, tokens, cost

## Context

In repository-scale agent runs, input token usage grows quadratically because the full conversation history is resent at every turn. Empirically, cache-creation and cache-read tokens account for over 97% of total token costs. A framework that only counts output tokens dramatically understates the operational cost of a run.

The resource loss measures the agent's total weighted token footprint against a task-specific budget `B`.

## Objective

Implement `compute_resource_loss(trajectory: list[dict], budget: int, delta: float, gamma: float) -> float` that returns a normalized loss in `[0, 1]`.

## Acceptance Criteria

- [ ] Computes weighted token total:
  ```
  C_total = C_fresh + δ · C_cached + γ · C_output
  ```
  where `C_fresh` = sum of `fresh_tokens`, `C_cached` = sum of `cached_tokens`, `C_output` = sum of `output_tokens` across all trajectory steps.
- [ ] `L_resource = min(C_total / B, 1.0)`.
- [ ] Default cost ratios: `δ = 0.1` (cached reads are heavily discounted), `γ = 1.0` (output tokens at full cost). Both must be configurable.
- [ ] Default budget `B = 250_000` tokens. Must be configurable per task.
- [ ] Returns `1.0` if total exceeds budget (not higher — loss is capped).
- [ ] Provides a breakdown dict alongside the scalar loss: `{"fresh": int, "cached": int, "output": int, "weighted_total": float, "budget": int}`.
- [ ] Unit tests cover: zero tokens → `0.0`, exactly at budget → `1.0`, cached-heavy run vs fresh-heavy run with same raw total (cached run should have lower loss), delta=0 edge case.

## Implementation Notes

### Cost Ratio Rationale

Anthropic's prompt caching prices cached input reads at approximately 10% of the fresh input price (`δ ≈ 0.1`). These ratios should be loaded from a provider config file rather than hardcoded, so the framework stays accurate as pricing changes.

### Why This Matters for Condition N vs K

Under **Condition N** (raw filesystem), the agent repeatedly reads large files into context, creating fresh tokens each turn. Under **Condition K** (`kb`-enabled), the agent queries compact index summaries, generating fewer fresh tokens and higher cache reuse. The resource loss should reflect this difference numerically.

### Budget Selection

The default budget of 250,000 tokens corresponds to roughly 5 turns on a 50k-context model with moderate history. Task-specific budgets should be set at task definition time and stored in the task manifest.

## Output Artifact

`eval/losses/resource_loss.py`  
`eval/config/provider_costs.json` — cost ratio config

## Dependencies

TICKET-001

## Feeds Into

TICKET-006
