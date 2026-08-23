import { describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/storage/base-selection.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@kb/core/storage/base-selection.js')>()
  return {
    ...actual,
    resolveEffectiveBaseDir: vi.fn(async () => {
      throw new Error('EACCES: permission denied, mkdir')
    }),
  }
})

import { resolveActiveBaseInfo, resolveActiveBaseName } from '@kb/client/api/server-connection.js'

/**
 * `resolveActiveBaseName`/`resolveActiveBaseInfo` only swallow
 * `resolveEffectiveBaseDir`'s documented "no active base selected" failure into
 * the `default` fallback — any other error (a real I/O failure reading or
 * creating the active-base state) must propagate instead of being silently
 * hidden behind an unrelated base.
 */
describe('resolveActiveBaseInfo error narrowing', () => {
  it('[TC-DMW6] propagates a non-"no active base" error instead of falling back to default', async () => {
    const prevBase = process.env.KB_BASE
    delete process.env.KB_BASE

    await expect(resolveActiveBaseInfo()).rejects.toThrow('EACCES')
    await expect(resolveActiveBaseName({})).rejects.toThrow('EACCES')

    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
  })
})
