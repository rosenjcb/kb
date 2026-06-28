import { describe, expect, it, vi } from 'vitest'
import { parseDuration, startReindexScheduler } from '../../src/server/reindex-scheduler'

describe('parseDuration', () => {
                it('[TC-26] parses unit suffixes', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('10s')).toBe(10_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('1h')).toBe(3_600_000)
  })

                it('[TC-27] treats bare numbers as milliseconds', () => {
    expect(parseDuration('250')).toBe(250)
  })

                it('[TC-28] defaults to one hour when unset or empty', () => {
    expect(parseDuration(undefined)).toBe(3_600_000)
    expect(parseDuration('')).toBe(3_600_000)
  })

  it('[TC-29] returns 0 (disabled) for "0"', () => {
    expect(parseDuration('0')).toBe(0)
  })

                it('[TC-30] returns undefined for malformed values', () => {
    expect(parseDuration('soon')).toBeUndefined()
    expect(parseDuration('5x')).toBeUndefined()
  })
})

describe('startReindexScheduler', () => {
                it('[TC-31] is inert when interval <= 0', async () => {
    const runReindex = vi.fn(async () => 'ok')
    const scheduler = startReindexScheduler({ intervalMs: 0, runReindex })
    expect(scheduler.isRunning()).toBe(false)
    scheduler.stop()
    expect(runReindex).not.toHaveBeenCalled()
  })

                it('[TC-32] runs ticks and skips overlapping runs', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst: (() => void) | undefined
      const runReindex = vi.fn(
        () =>
          new Promise<string>(resolve => {
            resolveFirst = () => resolve('done')
          })
      )
      const scheduler = startReindexScheduler({ intervalMs: 1000, runReindex })

      // First tick starts a run that has not resolved yet.
      await vi.advanceTimersByTimeAsync(1000)
      expect(runReindex).toHaveBeenCalledTimes(1)
      expect(scheduler.isRunning()).toBe(true)

      // Second tick is skipped because the first is still in flight.
      await vi.advanceTimersByTimeAsync(1000)
      expect(runReindex).toHaveBeenCalledTimes(1)

      // Let the first run finish; a later tick runs again.
      resolveFirst?.()
      await Promise.resolve()
      expect(scheduler.isRunning()).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(runReindex).toHaveBeenCalledTimes(2)

      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

                it('[TC-33] does not emit a completion line when a tick is intentionally skipped', async () => {
    vi.useFakeTimers()
    try {
      const runReindex = vi.fn(async () => undefined)
      const onLog = vi.fn()
      const scheduler = startReindexScheduler({ intervalMs: 1000, runReindex, onLog })

      await vi.advanceTimersByTimeAsync(1000)

      expect(runReindex).toHaveBeenCalledTimes(1)
      expect(onLog).toHaveBeenCalledWith('[reindex] scheduled every 1000ms')
      expect(onLog).not.toHaveBeenCalledWith(expect.stringContaining('(1'))

      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
