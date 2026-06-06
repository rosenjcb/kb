# TICKET-005: Resource Consumption Loss (`L_resource`)

**Status:** Open  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, tokens, cost

## Context

In repository-scale agent runs, input token usage grows quadratically because the full conversation history is resent at every turn. Cache-creation and cache-read tokens account for the vast majority of total token costs. A framework that only counts output tokens dramatically understates the operational cost of a run.

`src/core/telemetry.ts` already uses `pricetoken` (`^0.13.10`, confirmed in `package.json`) to estimate costs per stage via `estimateCost()`. The resource loss extends the same intuition: it computes a weighted token total from the per-step data in `TrajectoryFile` (from TICKET-001) and normalizes it against a task budget.

### Critical distinction: existing telemetry does NOT track cached vs. fresh input tokens

`StageMetrics` (lines 16–25 of `src/core/telemetry.ts`) has exactly two token fields:

```ts
export interface StageMetrics {
  stage: string
  startedAt: string
  durationMs: number
  inputTokens: number    // undifferentiated total — fresh + cached combined
  outputTokens: number
  estimatedCostUsd: number
  provider: string
  model: string
}
```

`TokenCountingProvider.getAndReset()` (line 213) returns:

```ts
{ inputTokens: number; outputTokens: number }
```

There is no `cachedTokens` field anywhere in `TokenCountingProvider`, `StageMetrics`, or `RunReport`. The provider accumulates `response.usage.inputTokens` and `response.usage.outputTokens` only (lines 200–203).

`TrajectoryStep`, by contrast, DOES split the distinction. TICKET-001 defines `record_step` as:

```ts
record_step(
  toolName: string,
  arguments: Record<string, unknown>,
  tokens: { fresh: number; cached: number; output: number }
)
```

and each `TrajectoryStep` carries `freshTokens: number`, `cachedTokens: number`, `outputTokens: number` as separate fields. `computeResourceLoss` must use `TrajectoryStep` as its data source, NOT `StageMetrics` or `RunReport`, because only the trajectory has the fresh/cached split.

## Objective

Implement `computeResourceLoss(trajectory: TrajectoryFile, budget: number, delta: number, gamma: number): ResourceLossResult` returning a normalized loss in `[0, 1]` plus a breakdown object.

## Acceptance Criteria

- [ ] Weighted total: `C_total = C_fresh + δ · C_cached + γ · C_output` where each `C_*` is summed across all `TrajectoryStep` entries using `step.freshTokens`, `step.cachedTokens`, and `step.outputTokens` respectively.
- [ ] `L_resource = min(C_total / budget, 1.0)`.
- [ ] Default `delta = 0.1` (cached reads discounted — matches Anthropic's prompt caching pricing ratio), `gamma = 1.0` (output at full cost). Both configurable.
- [ ] Default `budget = 250_000`. Configurable per task.
- [ ] Returns `ResourceLossResult` with the following exact shape:

```ts
export interface ResourceLossResult {
  loss: number           // in [0, 1]
  freshTokens: number    // sum of step.freshTokens across TrajectoryFile.steps
  cachedTokens: number   // sum of step.cachedTokens across TrajectoryFile.steps
  outputTokens: number   // sum of step.outputTokens across TrajectoryFile.steps
  weightedTotal: number  // C_total before clamping
  budget: number         // the budget value used
}
```

- [ ] Cost ratios loaded from `eval/config/provider-costs.json` (fallback to defaults if file missing). File format: `{ "delta": 0.1, "gamma": 1.0 }`.
- [ ] Unit tests cover: zero tokens → `0.0`, exactly at budget → `1.0`, cached-heavy vs fresh-heavy run with same raw total (cached run has lower loss), `delta = 0` edge case.

## Implementation Notes

### Token field names — use TrajectoryStep, not StageMetrics

Do NOT attempt to derive `freshTokens`/`cachedTokens` from `StageMetrics.inputTokens`. That field is an undifferentiated total and the split is irrecoverable at that point. The `TrajectoryStep` fields populated by `TrajectoryCollector.record_step()` (TICKET-001) are the only source with the fresh/cached distinction. Sum directly over `TrajectoryFile.steps`:

```ts
for (const step of trajectory.steps) {
  fresh  += step.freshTokens
  cached += step.cachedTokens
  output += step.outputTokens
}
```

### Why `pricetoken` / `estimateCost` is not called here

`estimateCost(provider, model, inputTokens, outputTokens)` in `src/core/telemetry.ts` (lines 45–57) calls `calculateModelCost(model, inputTokens, outputTokens).totalCost` from `pricetoken`. It takes an undifferentiated `inputTokens` count and returns USD. The resource loss is a dimensionless efficiency ratio, not a dollar amount, and requires the fresh/cached split that `estimateCost` does not accept. The two can coexist: `estimateCost` is appropriate for USD reporting in the final evaluation report; `computeResourceLoss` covers the normalized efficiency metric.

The `model` string passed to `calculateModelCost` is whatever the `LLMProvider.model` getter returns (e.g. `"claude-sonnet-4-5"`) — `estimateCost` passes it through verbatim without transformation.

### Budget Selection

The 250,000 token default corresponds to roughly 5 turns on a model with a 50k context window under a moderate-history scenario. Task YAML files (TICKET-012) should specify `tokenBudget` explicitly — the default is a fallback for unspecified tasks.

### Integration with Existing Telemetry

`computeResourceLoss` reads `TrajectoryFile.steps` (produced by `TrajectoryCollector.compileTrajectory()` from TICKET-001). It does not read `RunReport`, `StageMetrics`, or any output of `RunCollector`. There is no need to modify `RunCollector`, `StageMetrics`, `TokenCountingProvider`, or `ReportWriter` for this ticket.

## Files to Create

- `eval/losses/resource-loss.ts` — exports `computeResourceLoss` and `ResourceLossResult`
- `eval/config/provider-costs.json` — `{ "delta": 0.1, "gamma": 1.0 }`

## Files to Reference (do not modify)

- `src/core/telemetry.ts` — `TokenCountingProvider`, `StageMetrics`, `estimateCost` for reference; note that `StageMetrics` has no `cachedTokens` field and `getAndReset()` returns only `{ inputTokens, outputTokens }`
- `package.json` — confirms `pricetoken@^0.13.10` is available if needed for USD reporting elsewhere

## Dependencies

TICKET-001 (`TrajectoryFile` type, `TrajectoryStep` with `freshTokens`/`cachedTokens`/`outputTokens` fields)

## Feeds Into

TICKET-006
