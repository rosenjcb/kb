# TICKET-006: MOEL Aggregator

**Status:** Implemented  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, core

## Context

The three individual loss components are computed independently. This ticket assembles them into the single `L_MOEL` scalar and produces the canonical per-run result object consumed by the evaluation harness.

```
L_MOEL = w_c · L_correctness + w_t · L_trajectory + w_r · L_resource

where L_correctness = μ · L_AST + (1 - μ) · L_jury
and   w_c + w_t + w_r = 1
```

## Objective

Implement `computeMoel(components: MoelComponents, weights: MoelWeights): MoelResult` that validates inputs, enforces weight constraints, and returns a structured result.

## TypeScript Interface Definitions

The codebase uses `interface` exclusively for data shapes (see `src/core/types.ts` and `src/core/telemetry.ts` — every exported data structure is an `interface`, never `type` or `class`). Follow the same convention here.

```typescript
/**
 * The four raw loss values fed into the aggregator.
 *
 * lAst and lJury come from TICKET-002 and TICKET-003 respectively.
 * Both are plain `number` scalars in [0, 1].
 *   - computeAstLoss(): Promise<number>         (TICKET-002)
 *   - computeJuryLoss(): Promise<number>         (TICKET-003, implied by AC)
 *
 * lTrajectory comes from TICKET-004:
 *   - computeTrajectoryLoss(): number            (sync, plain scalar)
 *
 * lResource comes from TICKET-005 via ResourceLossResult.loss:
 *   - computeResourceLoss(): ResourceLossResult  (destructure .loss field)
 *
 * All four must be resolved to plain numbers before constructing MoelComponents.
 */
export interface MoelComponents {
  lAst: number        // [0, 1] — Jaccard structural distance (TICKET-002)
  lJury: number       // [0, 1] — LLM jury semantic loss (TICKET-003)
  lTrajectory: number // [0, 1] — trajectory inefficiency loss (TICKET-004)
  lResource: number   // [0, 1] — resource consumption loss (TICKET-005, from ResourceLossResult.loss)
}

/**
 * Mixing weights and the AST/jury balance parameter.
 * Load from eval/config/moel-weights.json at runtime; these values are the fallback defaults.
 *
 * Invariant: wC + wT + wR === 1.0 within WEIGHT_SUM_EPSILON (1e-6).
 */
export interface MoelWeights {
  wC: number  // weight for correctness component — default 0.5
  wT: number  // weight for trajectory component  — default 0.3
  wR: number  // weight for resource component    — default 0.2
  mu: number  // AST/jury balance [0, 1]          — default 0.6
}

/**
 * The fully computed result for one agent run under one condition.
 * Must serialize to JSON with no `undefined` values — use optional fields
 * only where the value is genuinely absent, and always include taskId and condition.
 */
export interface MoelResult {
  // Aggregated scalar
  lMoel: number

  // Intermediate correctness sub-components (retained for auditability)
  lCorrectness: number
  lAst: number
  lJury: number

  // Other loss components (passed through from MoelComponents)
  lTrajectory: number
  lResource: number

  // The weights used to produce this result (snapshot for reproducibility)
  weights: MoelWeights

  // Run identity — required, never optional, so JSON.stringify produces no undefined gaps
  taskId: string
  condition: string  // e.g. "N" (no kb) or "K" (kb-enabled)
}

/**
 * Pairwise comparison across conditions for a single task.
 * The primary hypothesis check is results["N"].lMoel - results["K"].lMoel > 0,
 * meaning Condition N (raw filesystem) has higher loss than Condition K (kb-enabled).
 */
export interface ComparisonReport {
  conditions: string[]                // e.g. ["N", "K"]
  pairwise: Record<string, number>    // e.g. { "N-K": 0.23 } — positive confirms hypothesis
  hypothesisConfirmed: boolean        // true when L_MOEL(N) > L_MOEL(K)
}
```

## Acceptance Criteria

- [ ] `MoelComponents` fields `lAst`, `lJury`, `lTrajectory`, `lResource` — all `number` in `[0, 1]`.
- [ ] `MoelWeights` fields `wC`, `wT`, `wR`, `mu` — all `number` in `[0, 1]`, with `wC + wT + wR = 1` validated within `WEIGHT_SUM_EPSILON = 1e-6`.
- [ ] Throws `Error` with a descriptive message on any validation failure. Do not use custom error subclasses — the codebase throws plain `Error` (see `src/core/config.ts` pattern).
- [ ] Default weights: `wC = 0.5, wT = 0.3, wR = 0.2, mu = 0.6`.
- [ ] `MoelResult` serializes to JSON cleanly: no `undefined` values, all fields always present.
- [ ] `compareConditions(results: Record<string, MoelResult>): ComparisonReport` returns pairwise `L_MOEL` differences. The primary comparison is `results["N"].lMoel - results["K"].lMoel`; a positive value confirms the hypothesis.
- [ ] Unit tests: perfect run → `lMoel = 0.0`, maximum loss → `lMoel = 1.0`, weight validation failures (sum ≠ 1, negative weight, mu > 1), `mu` boundary values (0 and 1), comparison utility with N and K conditions.

## Implementation Notes

### Weight Defaults

`wC = 0.5, wT = 0.3, wR = 0.2` reflects that functional correctness is primary, trajectory efficiency secondary, raw token cost a signal but not the primary criterion. `mu = 0.6` weights AST loss slightly higher than jury loss to counteract agreeableness bias.

These defaults must be documented in `eval/config/moel-weights.json` and loaded at runtime. The file is the source of truth; the code values are fallbacks only. Follow the same loading pattern as `eval/config/provider-costs.json` (TICKET-005): attempt `fs.readFile`, catch any error and fall back to defaults. Do not throw on missing file.

### Float Precision for Weight Validation

```typescript
const WEIGHT_SUM_EPSILON = 1e-6

function validateWeights(w: MoelWeights): void {
  const sum = w.wC + w.wT + w.wR
  if (Math.abs(sum - 1.0) > WEIGHT_SUM_EPSILON) {
    throw new Error(
      `MoelWeights sum must equal 1.0 within ${WEIGHT_SUM_EPSILON}; got ${sum.toFixed(10)} (wC=${w.wC}, wT=${w.wT}, wR=${w.wR})`
    )
  }
  for (const [key, val] of Object.entries(w) as [keyof MoelWeights, number][]) {
    if (val < 0 || val > 1) {
      throw new Error(`MoelWeights.${key} must be in [0, 1]; got ${val}`)
    }
  }
}
```

`1e-6` is sufficient for weights specified to at most 4–6 decimal places. It is the same tolerance used in TICKET-002's Jaccard comparison and matches the precision of IEEE-754 double arithmetic for values near 1.0.

### Aggregation Formula

```typescript
function computeMoel(components: MoelComponents, weights: MoelWeights): MoelResult {
  validateComponents(components)
  validateWeights(weights)

  const lCorrectness = weights.mu * components.lAst + (1 - weights.mu) * components.lJury
  const lMoel =
    weights.wC * lCorrectness +
    weights.wT * components.lTrajectory +
    weights.wR * components.lResource

  return {
    lMoel,
    lCorrectness,
    lAst: components.lAst,
    lJury: components.lJury,
    lTrajectory: components.lTrajectory,
    lResource: components.lResource,
    weights,
    taskId: '',    // caller must set before storing
    condition: '', // caller must set before storing
  }
}
```

Note: `taskId` and `condition` are required fields on `MoelResult` but cannot be known inside `computeMoel`. Either pass them as additional parameters, or have the caller fill them in immediately after the call — do not leave them as empty strings in production paths.

### Assembling MoelComponents from Dependency Outputs

```typescript
// TICKET-002 returns Promise<number> directly
const lAst: number = await computeAstLoss(candidate, reference, language)

// TICKET-003 returns Promise<number> directly (same scalar pattern)
const lJury: number = await computeJuryLoss(candidate, reference, rubric, judgeConfigs)

// TICKET-004 returns number synchronously
const lTrajectory: number = computeTrajectoryLoss(trajectory, optimalActions, hLimit)

// TICKET-005 returns ResourceLossResult — destructure .loss field
const { loss: lResource } = computeResourceLoss(trajectory, budget, delta, gamma)

const components: MoelComponents = { lAst, lJury, lTrajectory, lResource }
```

### ComparisonReport Implementation

```typescript
function compareConditions(results: Record<string, MoelResult>): ComparisonReport {
  const conditions = Object.keys(results)
  const pairwise: Record<string, number> = {}

  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      const a = conditions[i]
      const b = conditions[j]
      pairwise[`${a}-${b}`] = results[a].lMoel - results[b].lMoel
    }
  }

  const hypothesisConfirmed =
    'N' in results && 'K' in results
      ? results['N'].lMoel > results['K'].lMoel
      : false

  return { conditions, pairwise, hypothesisConfirmed }
}
```

### JSON Config File Format

`eval/config/moel-weights.json` uses 2-space indentation and no trailing commas (enforced by biome.json formatter — `indentWidth: 2`, `trailingCommas: "es5"` does not apply to JSON). Include a `$schema`-style comment or inline `_comment` field is not idiomatic here — use a README or inline code comment instead.

```json
{
  "wC": 0.5,
  "wT": 0.3,
  "wR": 0.2,
  "mu": 0.6
}
```

Load it with `resolveJsonModule: true` (already set in `tsconfig.json`) or via `fs.readFile` + `JSON.parse`. The `fs.readFile` approach is preferred for a file that may not exist in all environments (same pattern as `provider-costs.json` in TICKET-005).

## Files to Create

- `eval/losses/moel.ts`
- `eval/config/moel-weights.json`

## Dependencies

TICKET-002 (`computeAstLoss(): Promise<number>`), TICKET-003 (`computeJuryLoss(): Promise<number>`), TICKET-004 (`computeTrajectoryLoss(): number`, `TrajectoryFile`), TICKET-005 (`computeResourceLoss(): ResourceLossResult`, `ResourceLossResult.loss`)

## Feeds Into

TICKET-010
