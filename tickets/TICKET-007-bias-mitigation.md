# TICKET-007: LLM Judge Bias Mitigation

**Status:** Implemented  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, bias, llm-judge

## Context

The LLM jury from TICKET-003 is susceptible to four systematic biases:

1. **Agreeableness bias** — models approve incorrect answers; TNR under 25%.
2. **Verbosity bias** — longer responses score higher regardless of correctness.
3. **Position/order bias** — in pairwise comparisons, the first response is systematically preferred.
4. **Self-enhancement bias** — a model prefers outputs from its own model family.

This ticket adds mitigation layers to the jury. Each mechanism is independently togglable for ablation studies.

## Objective

Extend `eval/losses/jury-loss.ts` (from TICKET-003) by adding a `BiasConfig` parameter to the jury runner. The four debiasing mechanisms are additive transforms on top of the base jury defined in TICKET-003; the veto logic and loss formula from TICKET-003 are not changed except where explicitly noted below.

## Provider Family Identification

Provider family is identified via the `readonly name` string literal on every `LLMProvider` instance, as defined in `src/core/llm-provider.ts`:

- `AnthropicProvider.name === 'anthropic'`
- `OpenAIProvider.name === 'openai'`
- `GeminiProvider.name === 'gemini'`
- `OllamaProvider.name === 'ollama'`

No enum exists. The `createProvider` factory accepts the discriminated union `'anthropic' | 'openai' | 'gemini' | 'ollama'` as its `provider` field. All family comparisons use `judge.provider.name === generatorProviderName` (string equality). The `generatorProviderName` field on the jury call must therefore be one of those four string literals.

## Extended Jury Runner Signature

TICKET-003's `runJury` is being defined for the first time in `eval/losses/jury-loss.ts`. This ticket specifies the complete target signature that file must export:

```typescript
// Types established by TICKET-003, extended here with BiasConfig and generatorProviderName.

interface JudgeConfig {
  provider: LLMProvider   // instance from src/core/llm-provider.ts
  // No additional fields — provider.name carries family identity
}

interface JuryInput {
  candidate: string       // Y: the output being evaluated
  reference: string       // Y*: the ground-truth reference
  rubric: string[]        // one atomic claim per item
}

interface JuryResult {
  loss: number            // L_jury in [0, 1]
  vetoed: boolean
  warnings: string[]      // consistency warnings, self-enhancement warnings
  judgeDetails: JudgeDetail[]
}

interface JudgeDetail {
  providerName: string    // judge.provider.name
  scores: Record<string, number>  // rubric key → raw score (pre-normalization)
  adjustedScores: Record<string, number>  // after verbosity normalization, if enabled
  weight: number          // 1.0 normally, 0.5 if self-enhancement down-weight applied
  vetoFlag: boolean
  positionConsistencyDelta?: number  // only present when enablePositionDebiasing is true
}

// The exported function — this is the exact signature to implement:
export async function runJury(
  input: JuryInput,
  judges: JudgeConfig[],
  biasConfig?: Partial<BiasConfig>,
  generatorProviderName?: 'anthropic' | 'openai' | 'gemini' | 'ollama'
): Promise<JuryResult>
```

`biasConfig` is merged with `DEFAULT_BIAS_CONFIG` (all fields optional from the caller's perspective). `generatorProviderName` is required only when `enforceModelFamilyDiversity` or self-enhancement detection is active; passing it when `enforceModelFamilyDiversity` is false is permitted but has no effect.

## BiasConfig Type

```typescript
export interface BiasConfig {
  vetoThreshold: number                // default 2 — min judges emitting veto_flag to trigger L_jury = 1.0
  enableVerbosityNormalization: boolean // default true
  enablePositionDebiasing: boolean      // default true
  enforceModelFamilyDiversity: boolean  // default true
}

export const DEFAULT_BIAS_CONFIG: BiasConfig = {
  vetoThreshold: 2,
  enableVerbosityNormalization: true,
  enablePositionDebiasing: true,
  enforceModelFamilyDiversity: true,
}
```

`BiasConfig` is a plain `interface` (not a class) and is exported from `eval/losses/jury-loss.ts` so callers can import it directly without a separate config module.

## Acceptance Criteria

### Agreeableness Bias

- [ ] The `analysis` field from each judge's JSON response is validated non-empty before the response is accepted. An empty or missing `analysis` is treated as malformed (same as TICKET-003) — the judge is counted as a veto.
- [ ] The veto threshold `V` is `biasConfig.vetoThreshold` (default 2). Veto trigger: `vetoCount >= V`.
- [ ] Verify on the 20-task calibration set (TICKET-008) that this reduces the agreeableness failure rate.

### Verbosity Bias

- [ ] The rubric passed to each judge includes an explicit conciseness criterion appended by `runJury` before rendering the meta-prompt: `"Is the response free of unnecessary verbosity and repetition?"`. This criterion is appended regardless of whether `enableVerbosityNormalization` is true; it is a prompt-level control independent of the score-level normalization.
- [ ] When `enableVerbosityNormalization` is true, each rubric item score from a judge is normalized before aggregation:
  ```
  candidateTokenCount = candidate.trim().split(/\s+/).length
  adjustedScore = rawScore / Math.log1p(candidateTokenCount)
  ```
  `adjustedScore` is stored in `JudgeDetail.adjustedScores`; `rawScore` in `JudgeDetail.scores`. Loss computation uses `adjustedScores` when normalization is enabled, `scores` when disabled.
- [ ] When `enableVerbosityNormalization` is false, `adjustedScores` equals `scores` and `JudgeDetail.weight` reflects only self-enhancement down-weighting (not verbosity).
- [ ] No tokenizer library is introduced. Whitespace splitting (`/\s+/`) is the sole approximation.

### Position/Order Bias

- [ ] When `enablePositionDebiasing` is true, each judge makes two calls:
  - Forward: `candidate` as candidate, `reference` as reference (normal ordering in the meta-prompt).
  - Reversed: `reference` as candidate, `reference` as reference — **no**, correct reversal: `reference` appears in the candidate slot and `candidate` appears in the reference slot of the meta-prompt. The prompt template from TICKET-003 labels these `{candidate}` and `{reference}`; swapping means populating `{candidate}` with `input.reference` and `{reference}` with `input.candidate`.
- [ ] The per-rubric score for that judge is the average of both orderings: `score = (forwardScore + reversedScore) / 2`.
- [ ] If `|forwardScore - reversedScore| > 2` for any rubric item (on the 0–5 scale), a consistency warning is pushed to `JuryResult.warnings` in the format:
  ```
  "Position consistency warning: judge <providerName> rubric item <key> delta=<delta>"
  ```
  and `JudgeDetail.positionConsistencyDelta` is set to `Math.max(delta_across_rubric_items)` for that judge.
- [ ] When `enablePositionDebiasing` is false, only the forward ordering is used and `positionConsistencyDelta` is omitted from `JudgeDetail`.

### Self-Enhancement Bias

- [ ] When `generatorProviderName` is provided and matches a judge's `provider.name` (string equality), that judge is flagged. Comparison: `judge.provider.name === generatorProviderName`.
- [ ] A warning is pushed to `JuryResult.warnings`:
  ```
  "Self-enhancement warning: judge <providerName> matches generator family, weight=0.5"
  ```
- [ ] That judge's `JudgeDetail.weight` is set to `0.5`. All other judges have weight `1.0`.
- [ ] The final loss formula uses weighted averaging across judges:
  ```
  totalWeight = sum of judgeDetail.weight for all judges
  weightedMeanScore = sum(judgeDetail.weight * meanAdjustedScore(judgeDetail)) / totalWeight
  L_jury = 1 - (weightedMeanScore / 5)
  ```
  where `meanAdjustedScore(d)` is the mean of `d.adjustedScores` across all rubric items.
- [ ] When `enforceModelFamilyDiversity` is true and `generatorProviderName` is provided, `runJury` throws at the start (before any LLM calls) if fewer than 2 distinct `provider.name` values exist among `judges` that differ from `generatorProviderName`. Concretely: `judges.filter(j => j.provider.name !== generatorProviderName)` must have at least 2 distinct `name` values. Error message: `"BiasConfig requires at least 2 judge provider families distinct from the generator family"`.

## Veto and Down-Weighting Composition

The veto mechanism and the down-weighting mechanism operate on different dimensions and do not interfere:

- **Veto counting is unweighted.** Each judge that emits `veto_flag: true` (or whose response is malformed) contributes exactly 1 to `vetoCount`, regardless of its `weight`. A self-enhancement-flagged judge with `weight=0.5` still increments `vetoCount` by 1 if it vetoes.
- **Down-weighting affects only score aggregation.** If `vetoCount >= biasConfig.vetoThreshold`, `L_jury = 1.0` immediately and the weighted score formula is not evaluated.
- **Consequence:** a single self-enhancement judge cannot suppress a veto by being down-weighted. The evaluation order inside `runJury` is:
  1. Collect all judge responses (running position-debiasing calls if enabled).
  2. Apply verbosity normalization to scores.
  3. Count veto flags. If `vetoCount >= vetoThreshold`, return `{ loss: 1.0, vetoed: true, ... }`.
  4. Otherwise compute weighted mean score and derive `L_jury`.

## Concrete Score Computation Examples

### Example A: No biases active (all flags false), 2 judges, 2 rubric items

```
judge1 (openai) scores: { rubric_1: 4, rubric_2: 3 }  weight=1.0
judge2 (gemini) scores: { rubric_1: 5, rubric_2: 4 }  weight=1.0

meanScore = ((4+3)/2 + (5+4)/2) / 2 = (3.5 + 4.5) / 2 = 4.0
L_jury = 1 - (4.0 / 5) = 0.20
```

### Example B: Verbosity normalization on, candidate = "Hello world foo" (3 tokens)

```
candidateTokenCount = "Hello world foo".trim().split(/\s+/).length = 3
Math.log1p(3) ≈ 1.386

judge1 raw scores: { rubric_1: 4, rubric_2: 3 }
adjustedScores:    { rubric_1: 4/1.386 ≈ 2.89, rubric_2: 3/1.386 ≈ 2.16 }
meanAdjustedScore = (2.89 + 2.16) / 2 ≈ 2.52
L_jury = 1 - (2.52 / 5) ≈ 0.496
```

### Example C: Self-enhancement down-weighting, 3 judges, generatorProviderName='openai'

```
judge1 (anthropic) scores mean=4.0  weight=1.0
judge2 (gemini)    scores mean=3.5  weight=1.0
judge3 (openai)    scores mean=5.0  weight=0.5   ← self-enhancement, down-weighted

totalWeight = 1.0 + 1.0 + 0.5 = 2.5
weightedMean = (1.0*4.0 + 1.0*3.5 + 0.5*5.0) / 2.5 = (4.0 + 3.5 + 2.5) / 2.5 = 10.0 / 2.5 = 4.0
L_jury = 1 - (4.0 / 5) = 0.20
```

Without down-weighting (openai at weight 1.0): mean = (4.0+3.5+5.0)/3 = 4.17, L_jury = 0.167. The down-weighting reduces the inflated openai score's influence.

### Example D: Veto triggered by down-weighted judge

```
judge1 (anthropic) veto_flag=false  weight=1.0
judge2 (gemini)    veto_flag=true   weight=1.0
judge3 (openai)    veto_flag=true   weight=0.5  ← self-enhancement

vetoCount = 2  (judge2 + judge3, weight irrelevant)
vetoThreshold = 2
vetoCount >= vetoThreshold → L_jury = 1.0, vetoed=true
```

The down-weighted judge3 still triggers the veto because veto counting is unweighted.

### Example E: Position debiasing consistency warning

```
judge1 (anthropic) forward rubric_1=5, reversed rubric_1=2
delta = |5 - 2| = 3 > 2 → warning emitted
averagedScore for rubric_1 = (5 + 2) / 2 = 3.5
JudgeDetail.positionConsistencyDelta = 3
```

## Files to Modify

- `eval/losses/jury-loss.ts` — add `BiasConfig`, `DEFAULT_BIAS_CONFIG`, extend `JuryInput` with `generatorProviderName`, extend `JudgeDetail`, rewrite `runJury` with the full signature above.

## Files to Create

- `eval/config/bias-config.json` — default `BiasConfig` values serialized as JSON, for use by CLI tooling and test fixtures:
  ```json
  {
    "vetoThreshold": 2,
    "enableVerbosityNormalization": true,
    "enablePositionDebiasing": true,
    "enforceModelFamilyDiversity": true
  }
  ```

## Unit Tests to Add

In addition to the TICKET-003 unit tests, add:

- Verbosity normalization: raw score 5 on a 1000-token candidate produces `adjustedScore = 5 / Math.log1p(1000) ≈ 0.724`.
- Position debiasing: forward=5, reversed=1 → averaged=3, warning emitted; forward=5, reversed=4 → averaged=4.5, no warning.
- Self-enhancement: openai judge on openai-generated output gets weight=0.5; warning in `JuryResult.warnings`.
- Family diversity enforcement: two judges both `'openai'` with `generatorProviderName='anthropic'` → no throw (2 distinct families? No: both judges are same family — throws because only 1 distinct non-generator family). Three judges: openai, openai, gemini with generator=anthropic → passes (2 distinct non-generator families: openai and gemini).
- Veto from down-weighted judge still triggers veto policy (Example D above).
- `biasConfig` omitted entirely → `DEFAULT_BIAS_CONFIG` used, no runtime error.

## Dependencies

TICKET-003

## Feeds Into

TICKET-008
