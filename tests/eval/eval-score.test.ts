import { describe, expect, it, vi } from 'vitest'

import {
  RUBRIC_AXES,
  buildRubric,
  scoreFromLabel,
  withRetry,
} from '../../scripts/eval-score.mjs'

describe('withRetry', () => {
  it('[TC-35] returns the result immediately when the fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('[TC-36] retries and succeeds on a later attempt', async () => {
    let calls = 0
    const fn = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'recovered'
    })
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 0 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('[TC-37] throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'))
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('fetch failed')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('[TC-38] does not retry on success even with attempts > 1', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    await withRetry(fn, { attempts: 5, baseDelayMs: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('label-based scoring', () => {
  it('[TC-225] every rubric axis defines five labels mapping onto ordinal levels 0–4', () => {
    expect(RUBRIC_AXES).toHaveLength(5)
    for (const axis of RUBRIC_AXES) {
      const scores = axis.labels.map(l => l.score).sort((a, b) => a - b)
      expect(scores).toEqual([0, 1, 2, 3, 4])
      // labels are distinct strings
      expect(new Set(axis.labels.map(l => l.label)).size).toBe(5)
    }
  })

  it('[TC-226] scoreFromLabel resolves a known label to its ordinal level', () => {
    expect(scoreFromLabel('correctness', 'correct')).toBe(4)
    expect(scoreFromLabel('correctness', 'mostly_correct')).toBe(3)
    expect(scoreFromLabel('relevance', 'unrelated')).toBe(0)
    expect(scoreFromLabel('evidence_handling', 'well_grounded')).toBe(4)
  })

  it('[TC-227] scoreFromLabel tolerates casing, spaces, and hyphens', () => {
    expect(scoreFromLabel('usefulness', 'Needs-Followup')).toBe(2)
    expect(scoreFromLabel('relevance', 'On Topic')).toBe(3)
  })

  it('[TC-228] scoreFromLabel falls back to the legacy numeric path', () => {
    expect(scoreFromLabel('correctness', 3)).toBe(3)
    expect(scoreFromLabel('correctness', '4')).toBe(4)
    expect(scoreFromLabel('correctness', 9)).toBe(4) // clamped
  })

  it('[TC-229] scoreFromLabel returns 0 for an unrecognized verdict', () => {
    expect(scoreFromLabel('correctness', 'banana')).toBe(0)
    expect(scoreFromLabel('correctness', null)).toBe(0)
    expect(scoreFromLabel('correctness', undefined)).toBe(0)
  })

  it('[TC-230] the rubric instructs the judge to pick labels, not numbers', () => {
    const rubric = buildRubric('the kb self-check', false)
    expect(rubric).toContain('output the label string')
    expect(rubric).toContain('"mostly_correct"')
    expect(rubric).not.toContain('integer 0')
  })
})
