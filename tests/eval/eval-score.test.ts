import { describe, expect, it, vi } from 'vitest'

import { withRetry } from '../../scripts/eval-score.mjs'

describe('withRetry', () => {
  it('returns the result immediately when the fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds on a later attempt', async () => {
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

  it('throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'))
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('fetch failed')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on success even with attempts > 1', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    await withRetry(fn, { attempts: 5, baseDelayMs: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
