import { describe, expect, it } from 'vitest'
// @ts-expect-error — eval harness is plain ESM JS, no type declarations
import { buildRubric } from '../../scripts/eval-score.mjs'
// @ts-expect-error — eval harness is plain ESM JS, no type declarations
import {
  computeAdequacyQuality,
  computeSuccessScore,
  parseCurationDetail,
  scoreMetric,
  summarizeCuration,
} from '../../scripts/eval-shared.mjs'

describe('relevance in the harvest success score', () => {
  it('[TC-113] Given a relevance arg, then quality averages three axes (back-compat without it)', () => {
    const twoAxis = computeAdequacyQuality(4, 4)
    const threeAxisHigh = computeAdequacyQuality(4, 4, 4)
    const threeAxisLow = computeAdequacyQuality(4, 4, 0)
    // All-4 is the same whether 2 or 3 axes.
    expect(threeAxisHigh).toBeCloseTo(twoAxis, 5)
    // A poor relevance axis drags quality down.
    expect(threeAxisLow).toBeLessThan(threeAxisHigh)
  })

  it('[TC-114] Given an off-topic-but-correct answer, then success_score is lower than a focused one', () => {
    const focused = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 4,
      meanRelevance: 4,
      totalTokens: 100_000,
      totalDurationMs: 60_000,
    })
    const cluttered = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 4,
      meanRelevance: 1,
      totalTokens: 100_000,
      totalDurationMs: 60_000,
    })
    expect(cluttered.success_score).toBeLessThan(focused.success_score)
    expect(cluttered.inputs.mean_relevance).toBe(1)
  })

  it('[TC-115] Given no relevance, then success_score matches the legacy two-axis quality', () => {
    const legacy = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 2,
      totalTokens: 0,
      totalDurationMs: 0,
    })
    expect(legacy.inputs.mean_relevance).toBeNull()
    expect(legacy.quality_score).toBeCloseTo(computeAdequacyQuality(4, 2), 5)
  })

  it('[TC-116] Given the rubric, then it scores a Relevance axis and requires it in the schema', () => {
    const rubric = buildRubric('the kb self-check', false)
    expect(rubric).toMatch(/Relevance —/)
    expect(rubric.toLowerCase()).toContain('unrelated')
  })
})

describe('curator retrieval-relevancy telemetry', () => {
  it('[TC-117] Given a retrieval detail with a curation segment, then it parses kept/dropped', () => {
    const parsed = parseCurationDetail(
      'hybrid facts-loop;passes:3;curated:kept=8,dropped=12,requeried=2,rounds=1;semantic:on'
    )
    expect(parsed).toEqual({ kept: 8, dropped: 12, requeried: 2, rounds: 1 })
  })

  it('[TC-118] Given details without curation, then parse returns null and summary is null', () => {
    expect(parseCurationDetail('hybrid facts-loop;passes:3')).toBeNull()
    expect(summarizeCuration(['hybrid facts-loop', null, undefined])).toBeNull()
  })

  it('[TC-119] Given several curated details, then it aggregates retrieval precision', () => {
    const summary = summarizeCuration([
      'curated:kept=8,dropped=2,requeried=0,rounds=1',
      'curated:kept=6,dropped=4,requeried=1,rounds=2',
    ])
    expect(summary?.total_kept).toBe(14)
    expect(summary?.total_dropped).toBe(6)
    expect(summary?.retrieval_precision).toBeCloseTo(14 / 20, 3)
    expect(summary?.questions_with_curation).toBe(2)
  })
})

describe('scoreMetric relevance + pass-gate preference', () => {
  it('[TC-120] Given the new fields, then scoreMetric reads relevance and the strict pass gate', () => {
    const artifact = {
      aggregate_scores: {
        query: {
          mean_relevance: 3.5,
          pass_rate_quality_axes_at_least_3: 0.75,
          pass_rate_correctness_and_usefulness_at_least_3: 0.875,
        },
      },
    }
    expect(scoreMetric(artifact, 'relevance')).toBe(3.5)
    expect(scoreMetric(artifact, 'pass_rate')).toBe(0.75)
  })

  it('[TC-121] Given only the legacy pass field, then scoreMetric falls back to it', () => {
    const artifact = {
      aggregate_scores: {
        query: { pass_rate_correctness_and_usefulness_at_least_3: 0.5 },
      },
    }
    expect(scoreMetric(artifact, 'pass_rate')).toBe(0.5)
  })
})
