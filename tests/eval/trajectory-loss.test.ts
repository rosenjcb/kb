import { describe, expect, it } from 'vitest'
import { computeTrajectoryLoss } from '../../eval/losses/trajectory-loss'
import type { TrajectoryFile } from '@kb/core/core/telemetry.js'

function makeTrajectory(
  steps: Array<{ toolName: string; args?: Record<string, unknown> }>,
  condition: 'N' | 'K' | 'O' = 'K'
): TrajectoryFile {
  return {
    taskId: 'test-task',
    condition,
    totalSteps: steps.length,
    elapsedMs: 0,
    steps: steps.map((s, i) => ({
      stepIndex: i,
      timestampMs: i * 100,
      toolName: s.toolName,
      arguments: s.args ?? {},
      freshTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    })),
  }
}

describe('computeTrajectoryLoss', () => {
  it('[TC-148] Given an empty trajectory, returns 0', () => {
    expect(computeTrajectoryLoss(makeTrajectory([]), [], 20)).toBe(0)
  })

  it('[TC-149] Given 5 unique steps within limit, returns expected combined loss', () => {
    const t = makeTrajectory([
      { toolName: 'read_facts', args: { id: '1' } },
      { toolName: 'read_facts', args: { id: '2' } },
      { toolName: 'read_facts', args: { id: '3' } },
      { toolName: 'search_code', args: { q: 'foo' } },
      { toolName: 'get_neighbors', args: { id: '1' } },
    ])
    // stepDeviation = 5/20 = 0.25, redundancyRatio = 0/5 = 0
    // loss = 0.5 * 0.25 + 0.5 * 0 = 0.125
    expect(computeTrajectoryLoss(t, [], 20)).toBeCloseTo(0.125)
  })

  it('[TC-150] Given same tool called 5 times with identical args, returns high redundancy', () => {
    const t = makeTrajectory([
      { toolName: 'read_facts', args: { id: 'fact-1' } },
      { toolName: 'read_facts', args: { id: 'fact-1' } },
      { toolName: 'read_facts', args: { id: 'fact-1' } },
      { toolName: 'read_facts', args: { id: 'fact-1' } },
      { toolName: 'read_facts', args: { id: 'fact-1' } },
    ])
    // stepDeviation = 5/20 = 0.25, redundancyRatio = 4/5 = 0.8
    // loss = 0.5 * 0.25 + 0.5 * 0.8 = 0.525
    expect(computeTrajectoryLoss(t, [], 20)).toBeCloseTo(0.525)
  })

  it('[TC-151] Given step count at ceiling, step component equals 1.0', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ toolName: `tool_${i}`, args: { i } }))
    // stepDeviation = 20/20 = 1.0, no duplicates → loss = 0.5
    expect(computeTrajectoryLoss(makeTrajectory(steps), [], 20)).toBeCloseTo(0.5)
  })

  it('[TC-152] Given step count exceeding ceiling, loss is clamped at 1.0', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ toolName: `tool_${i}`, args: {} }))
    expect(computeTrajectoryLoss(makeTrajectory(steps), [], 20)).toBeLessThanOrEqual(1.0)
  })

  it('[TC-153] Same tool with different args does not count as duplicate', () => {
    const t = makeTrajectory([
      { toolName: 'read_facts', args: { id: 'fact-1' } },
      { toolName: 'read_facts', args: { id: 'fact-2' } },
    ])
    // redundancyRatio = 0
    expect(computeTrajectoryLoss(t, [], 20)).toBeCloseTo(0.5 * (2 / 20))
  })
})
