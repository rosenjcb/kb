import { describe, expect, it, vi } from 'vitest'
import {
  createRateLimitedYielder,
  yieldEvery,
  yieldToEventLoop,
} from '@kb/core/core/yield.js'

describe('event-loop yield helpers', () => {
  it('yieldEvery only yields on stride boundaries', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate')
    try {
      await yieldEvery(1, 10)
      await yieldEvery(5, 10)
      expect(spy).not.toHaveBeenCalled()
      await yieldEvery(10, 10)
      expect(spy).toHaveBeenCalledTimes(1)
      await yieldEvery(20, 10)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('createRateLimitedYielder yields on first call and after the interval', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((cb: () => void) => {
      cb()
      return 0 as unknown as NodeJS.Immediate
    }) as typeof setImmediate)
    try {
      const maybeYield = createRateLimitedYielder(50)
      await maybeYield()
      expect(spy).toHaveBeenCalledTimes(1)
      await maybeYield()
      expect(spy).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(50)
      await maybeYield()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('yieldToEventLoop resolves on the next immediate', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined()
  })
})
