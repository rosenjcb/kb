import { describe, expect, it } from 'vitest'
import {
  runJury,
  parseVerdict,
  DEFAULT_BIAS_CONFIG,
} from '../../eval/losses/jury-loss'
import type {
  JudgeConfig,
  JuryInput,
  BiasConfig,
} from '../../eval/losses/jury-loss'
import type { LLMProvider, LLMCallParams, LLMResponse } from '../../src/core/types'

// ── Mock helpers ─────────────────────────────────────────────────────────────

interface Verdict {
  analysis: string
  scores: Record<string, number>
  veto_flag: boolean
  veto_reason: string
}

function mockProvider(name: string, responses: Array<Verdict | null>): LLMProvider {
  let callCount = 0
  return {
    name,
    model: 'mock',
    supportsStreaming: false,
    async call(_params: LLMCallParams): Promise<LLMResponse> {
      const r = responses[callCount % responses.length]
      callCount++
      return {
        text: r ? JSON.stringify(r) : 'not-valid-json',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
}

function makeVerdict(scores: Record<string, number>, veto = false): Verdict {
  return { analysis: 'step-by-step reasoning here', scores, veto_flag: veto, veto_reason: '' }
}

const SIMPLE_BIAS: Partial<BiasConfig> = {
  enablePositionDebiasing: false,
  enableVerbosityNormalization: false,
  enforceModelFamilyDiversity: false,
  vetoThreshold: 2,
}

const input: JuryInput = {
  candidate: 'hello world',
  reference: 'hello world',
  rubric: ['Is the answer correct?', 'Is the explanation clear?'],
}

// ── parseVerdict ──────────────────────────────────────────────────────────────

describe('parseVerdict', () => {
  it('Returns null for invalid JSON', () => {
    expect(parseVerdict('not json')).toBeNull()
  })

  it('Returns null when analysis is empty', () => {
    expect(parseVerdict(JSON.stringify({ analysis: '', scores: {}, veto_flag: false, veto_reason: '' }))).toBeNull()
  })

  it('Returns null when veto_flag is missing', () => {
    expect(parseVerdict(JSON.stringify({ analysis: 'ok', scores: {} }))).toBeNull()
  })

  it('Returns parsed verdict for valid input', () => {
    const v = makeVerdict({ rubric_1: 5 })
    expect(parseVerdict(JSON.stringify(v))).toMatchObject({ veto_flag: false })
  })
})

// ── runJury: core cases ───────────────────────────────────────────────────────

describe('runJury — core', () => {
  it('All judges agree with score 5 → loss = 0', async () => {
    const scores = { rubric_1: 5, rubric_2: 5, rubric_3: 5 }
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [makeVerdict(scores)]) },
      { provider: mockProvider('openai', [makeVerdict(scores)]) },
      { provider: mockProvider('gemini', [makeVerdict(scores)]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS)
    expect(result.vetoed).toBe(false)
    expect(result.loss).toBeCloseTo(0)
  })

  it('All judges score 0 → loss = 1', async () => {
    const scores = { rubric_1: 0, rubric_2: 0, rubric_3: 0 }
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [makeVerdict(scores)]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS)
    expect(result.vetoed).toBe(false)
    expect(result.loss).toBeCloseTo(1)
  })

  it('One judge vetoes, 2 do not → not vetoed (count < threshold)', async () => {
    const good = makeVerdict({ rubric_1: 4, rubric_2: 4, rubric_3: 4 })
    const bad = makeVerdict({ rubric_1: 0 }, true)
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [good]) },
      { provider: mockProvider('openai', [bad]) },
      { provider: mockProvider('gemini', [good]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS)
    expect(result.vetoed).toBe(false)
  })

  it('Two judges veto → L_jury = 1.0, vetoed = true', async () => {
    const vetoV = makeVerdict({}, true)
    const good = makeVerdict({ rubric_1: 5, rubric_2: 5, rubric_3: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [vetoV]) },
      { provider: mockProvider('openai', [vetoV]) },
      { provider: mockProvider('gemini', [good]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS)
    expect(result.vetoed).toBe(true)
    expect(result.loss).toBe(1.0)
  })

  it('Malformed JSON → counts as veto; two malformed judges → L_jury = 1.0', async () => {
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [null]) },
      { provider: mockProvider('openai', [null]) },
      { provider: mockProvider('gemini', [makeVerdict({ rubric_1: 5, rubric_2: 5, rubric_3: 5 })]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS)
    expect(result.vetoed).toBe(true)
    expect(result.loss).toBe(1.0)
  })

  it('biasConfig omitted entirely → DEFAULT_BIAS_CONFIG applied, no runtime error', async () => {
    // With default config, position debiasing is ON (2 calls per judge).
    // Supply 2 responses per provider.
    const v = makeVerdict({ rubric_1: 4, rubric_2: 4, rubric_3: 4 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [v, v]) },
      { provider: mockProvider('openai', [v, v]) },
      { provider: mockProvider('gemini', [v, v]) },
    ]
    await expect(runJury(input, judges)).resolves.not.toThrow()
  })

  it('Mixed scores produce expected L_jury (no biases)', async () => {
    // judge1: rubric_1=4, rubric_2=3 → mean=3.5
    // judge2: rubric_1=5, rubric_2=4 → mean=4.5
    // weightedMean = (3.5 + 4.5) / 2 = 4.0  → loss = 1 - 4/5 = 0.20
    const j1 = makeVerdict({ rubric_1: 4, rubric_2: 3 })
    const j2 = makeVerdict({ rubric_1: 5, rubric_2: 4 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [j1]) },
      { provider: mockProvider('openai', [j2]) },
    ]
    const result = await runJury(input, judges, { ...SIMPLE_BIAS })
    expect(result.loss).toBeCloseTo(0.2)
  })
})

// ── Verbosity normalization ───────────────────────────────────────────────────

describe('runJury — verbosity normalization', () => {
  it('raw score 5 on 1000-token candidate → adjustedScore ≈ 0.724', async () => {
    // Build a candidate string of ~1000 whitespace-separated tokens
    const candidateLong = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ')
    const longInput: JuryInput = { candidate: candidateLong, reference: 'ref', rubric: ['Is it correct?'] }

    const v = makeVerdict({ rubric_1: 5, rubric_2: 5 })
    const judges: JudgeConfig[] = [{ provider: mockProvider('anthropic', [v]) }]

    const result = await runJury(longInput, judges, {
      ...SIMPLE_BIAS,
      enableVerbosityNormalization: true,
    })
    // adjustedScore = 5 / log1p(1000) ≈ 5 / 6.908 ≈ 0.724
    const adjustedScores = Object.values(result.judgeDetails[0].adjustedScores)
    for (const s of adjustedScores) {
      expect(s).toBeCloseTo(0.724, 2)
    }
  })

  it('Normalization off → adjustedScores equal raw scores', async () => {
    const v = makeVerdict({ rubric_1: 3, rubric_2: 4 })
    const judges: JudgeConfig[] = [{ provider: mockProvider('anthropic', [v]) }]
    const result = await runJury(input, judges, { ...SIMPLE_BIAS, enableVerbosityNormalization: false })
    expect(result.judgeDetails[0].adjustedScores).toEqual(result.judgeDetails[0].scores)
  })
})

// ── Position debiasing ────────────────────────────────────────────────────────

describe('runJury — position debiasing', () => {
  it('forward=5, reversed=1 → averaged=3, warning emitted', async () => {
    const forward = makeVerdict({ rubric_1: 5 })
    const reversed = makeVerdict({ rubric_1: 1 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [forward, reversed]) },
    ]
    const result = await runJury(
      { candidate: 'x', reference: 'y', rubric: ['Is it correct?'] },
      judges,
      { ...SIMPLE_BIAS, enablePositionDebiasing: true }
    )
    expect(result.judgeDetails[0].scores.rubric_1).toBeCloseTo(3)
    expect(result.warnings.some(w => w.includes('Position consistency warning'))).toBe(true)
    expect(result.judgeDetails[0].positionConsistencyDelta).toBe(4)
  })

  it('forward=5, reversed=4 → averaged=4.5, no consistency warning', async () => {
    const forward = makeVerdict({ rubric_1: 5 })
    const reversed = makeVerdict({ rubric_1: 4 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [forward, reversed]) },
    ]
    const result = await runJury(
      { candidate: 'x', reference: 'y', rubric: ['Is it correct?'] },
      judges,
      { ...SIMPLE_BIAS, enablePositionDebiasing: true }
    )
    expect(result.judgeDetails[0].scores.rubric_1).toBeCloseTo(4.5)
    expect(result.warnings.filter(w => w.includes('Position consistency'))).toHaveLength(0)
  })

  it('positionConsistencyDelta absent when debiasing is off', async () => {
    const v = makeVerdict({ rubric_1: 4 })
    const judges: JudgeConfig[] = [{ provider: mockProvider('anthropic', [v]) }]
    const result = await runJury(input, judges, { ...SIMPLE_BIAS, enablePositionDebiasing: false })
    expect(result.judgeDetails[0].positionConsistencyDelta).toBeUndefined()
  })
})

// ── Self-enhancement ──────────────────────────────────────────────────────────

describe('runJury — self-enhancement', () => {
  it('openai judge with generatorProviderName=openai → weight=0.5, warning emitted', async () => {
    const v = makeVerdict({ rubric_1: 5, rubric_2: 5, rubric_3: 5 })
    const judges: JudgeConfig[] = [{ provider: mockProvider('openai', [v]) }]
    const result = await runJury(input, judges, SIMPLE_BIAS, 'openai')
    expect(result.judgeDetails[0].weight).toBe(0.5)
    expect(result.warnings.some(w => w.includes('Self-enhancement warning'))).toBe(true)
  })

  it('Down-weighted judge still contributes its veto count (Example D)', async () => {
    const vetoV = makeVerdict({}, true)
    const good = makeVerdict({ rubric_1: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [good]) },  // weight=1.0, no veto
      { provider: mockProvider('gemini', [vetoV]) },    // weight=1.0, veto
      { provider: mockProvider('openai', [vetoV]) },    // weight=0.5 (self-enhance), veto
    ]
    // vetoCount = 2 (gemini + openai) ≥ vetoThreshold=2 → L_jury=1.0
    const result = await runJury(input, judges, SIMPLE_BIAS, 'openai')
    expect(result.vetoed).toBe(true)
    expect(result.loss).toBe(1.0)
  })

  it('Weighted mean correctly down-weights self-enhancement judge (Example C)', async () => {
    // anthropic mean=4.0, gemini mean=3.5, openai (generator) mean=5.0 weight=0.5
    // weightedMean = (4.0 + 3.5 + 0.5*5.0) / (1+1+0.5) = 10/2.5 = 4.0 → loss=0.20
    const j1 = makeVerdict({ rubric_1: 4 })
    const j2 = makeVerdict({ rubric_1: 4, rubric_2: 3 })  // mean=(4+3)/2=3.5
    const j3 = makeVerdict({ rubric_1: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('anthropic', [j1]) },
      { provider: mockProvider('gemini', [j2]) },
      { provider: mockProvider('openai', [j3]) },
    ]
    const result = await runJury(input, judges, SIMPLE_BIAS, 'openai')
    expect(result.loss).toBeCloseTo(0.2)
  })
})

// ── Model family diversity enforcement ───────────────────────────────────────

describe('runJury — model family diversity', () => {
  it('Two openai judges + generator=anthropic → throws (only 1 distinct non-generator family)', async () => {
    const v = makeVerdict({ rubric_1: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('openai', [v]) },
      { provider: mockProvider('openai', [v]) },
    ]
    await expect(
      runJury(input, judges, { ...SIMPLE_BIAS, enforceModelFamilyDiversity: true }, 'anthropic')
    ).rejects.toThrow('BiasConfig requires at least 2 judge provider families')
  })

  it('openai + gemini judges + generator=anthropic → does not throw', async () => {
    const v = makeVerdict({ rubric_1: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('openai', [v]) },
      { provider: mockProvider('gemini', [v]) },
    ]
    await expect(
      runJury(input, judges, { ...SIMPLE_BIAS, enforceModelFamilyDiversity: true }, 'anthropic')
    ).resolves.toBeDefined()
  })

  it('enforceModelFamilyDiversity=false → skips diversity check even with same-family judges', async () => {
    const v = makeVerdict({ rubric_1: 5 })
    const judges: JudgeConfig[] = [
      { provider: mockProvider('openai', [v]) },
      { provider: mockProvider('openai', [v]) },
    ]
    await expect(
      runJury(input, judges, { ...SIMPLE_BIAS, enforceModelFamilyDiversity: false }, 'anthropic')
    ).resolves.toBeDefined()
  })
})
