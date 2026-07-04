import { afterEach, describe, expect, it } from 'vitest'
import { parseQueryTimeoutMs, resolveQueryTimeoutMs } from '@kb/core/config/query-timeout.js'

describe('query-timeout', () => {
  const prev = process.env.KB_QUERY_TIMEOUT

  afterEach(() => {
    if (prev === undefined) delete process.env.KB_QUERY_TIMEOUT
    else process.env.KB_QUERY_TIMEOUT = prev
  })

  it('[TC-1] defaults to 60s when unset', () => {
    delete process.env.KB_QUERY_TIMEOUT
    expect(parseQueryTimeoutMs(undefined)).toBe(60_000)
    expect(resolveQueryTimeoutMs()).toBe(60_000)
  })

  it('[TC-2] parses duration suffixes', () => {
    expect(parseQueryTimeoutMs('90s')).toBe(90_000)
    expect(parseQueryTimeoutMs('2m')).toBe(120_000)
    expect(parseQueryTimeoutMs('500ms')).toBe(500)
  })

  it('[TC-3] parses bare milliseconds', () => {
    expect(parseQueryTimeoutMs('120000')).toBe(120_000)
  })

  it('[TC-4] rejects invalid values', () => {
    expect(parseQueryTimeoutMs('nope')).toBeUndefined()
    expect(() => resolveQueryTimeoutMs('nope')).toThrow(/Invalid KB_QUERY_TIMEOUT/)
  })
})
