import { describe, expect, it } from 'vitest'
import { computeResourceLoss } from '../../eval/losses/resource-loss'
import type { TrajectoryFile } from '@kb/core/core/telemetry.js'

function makeTrajectory(
  steps: Array<{ fresh?: number; cached?: number; output?: number }>
): TrajectoryFile {
  return {
    taskId: 'test-task',
    condition: 'K',
    totalSteps: steps.length,
    elapsedMs: 0,
    steps: steps.map((s, i) => ({
      stepIndex: i,
      timestampMs: i * 100,
      toolName: 'tool',
      arguments: {},
      freshTokens: s.fresh ?? 0,
      cachedTokens: s.cached ?? 0,
      outputTokens: s.output ?? 0,
    })),
  }
}

describe('computeResourceLoss', () => {
  it('[TC-122] Given zero tokens, returns loss = 0 and weightedTotal = 0', () => {
    const result = computeResourceLoss(makeTrajectory([{ fresh: 0, cached: 0, output: 0 }]))
    expect(result.loss).toBe(0)
    expect(result.weightedTotal).toBe(0)
  })

  it('[TC-123] Given exactly at budget (fresh only), returns loss = 1.0', () => {
    const budget = 250_000
    const result = computeResourceLoss(makeTrajectory([{ fresh: budget }]), budget, 0.1, 1.0)
    expect(result.loss).toBe(1.0)
  })

  it('[TC-124] Given tokens far above budget, loss is clamped at 1.0', () => {
    const result = computeResourceLoss(makeTrajectory([{ fresh: 1_000_000 }]), 250_000)
    expect(result.loss).toBe(1.0)
  })

  it('[TC-125] Cached-heavy run has lower loss than fresh-heavy run with same raw total', () => {
    const total = 100_000
    const freshResult = computeResourceLoss(makeTrajectory([{ fresh: total }]), 250_000, 0.1, 1.0)
    const cachedResult = computeResourceLoss(makeTrajectory([{ cached: total }]), 250_000, 0.1, 1.0)
    expect(cachedResult.loss).toBeLessThan(freshResult.loss)
  })

  it('[TC-126] Given delta = 0, cached tokens contribute nothing to weightedTotal', () => {
    const result = computeResourceLoss(
      makeTrajectory([{ fresh: 0, cached: 100_000, output: 0 }]),
      250_000,
      0,
      1.0
    )
    expect(result.weightedTotal).toBe(0)
    expect(result.loss).toBe(0)
  })

  it('[TC-127] Breakdown fields are summed correctly across multiple steps', () => {
    const t = makeTrajectory([
      { fresh: 1000, cached: 2000, output: 500 },
      { fresh: 500, cached: 0, output: 100 },
    ])
    const result = computeResourceLoss(t, 250_000, 0.1, 1.0)
    expect(result.freshTokens).toBe(1500)
    expect(result.cachedTokens).toBe(2000)
    expect(result.outputTokens).toBe(600)
    // weightedTotal = 1500 + 0.1*2000 + 1.0*600 = 1500 + 200 + 600 = 2300
    expect(result.weightedTotal).toBeCloseTo(2300)
  })

  it('[TC-128] Result budget field reflects the budget passed in', () => {
    const result = computeResourceLoss(makeTrajectory([]), 100_000)
    expect(result.budget).toBe(100_000)
  })
})
