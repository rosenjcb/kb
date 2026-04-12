import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  formatUseCommandHelp,
} from '../../src/cli/base-selection'

describe('base-selection', () => {
  const env = process.env

  afterEach(() => {
    process.env = { ...env }
    vi.restoreAllMocks()
  })

  it('Given alias base, then resolves to namespaced documents directory', () => {
    const dir = resolveBaseToDir('dogfood', '/repo')
    expect(dir).toBe('/repo/sessions/namespaces/dogfood/documents')
  })

  it('Given path-like base, then resolves to absolute directory', () => {
    const dir = resolveBaseToDir('./tmp/docs', '/repo')
    expect(dir).toBe('/repo/tmp/docs')
  })

  it('Given sessionBase set, then effective resolution uses it first', async () => {
    process.env.KB_BASE = 'dogfood'

    const result = await resolveEffectiveBaseDir('/repo', {
      sessionBase: 'session-base',
      defaultBase: 'default-base',
    })

    expect(result.source).toBe('config.sessionBase')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/session-base/documents')
  })

  it('Given defaultBase set and no sessionBase, then effective resolution uses default', async () => {
    delete process.env.KB_BASE

    const result = await resolveEffectiveBaseDir('/repo', {
      defaultBase: 'dogfood',
    })

    expect(result.source).toBe('config.defaultBase')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/dogfood/documents')
  })

  it('Given KB_BASE set and no configured bases, then effective resolution uses alias mapping', async () => {
    process.env.KB_BASE = 'dogfood'

    const result = await resolveEffectiveBaseDir('/repo', {})

    expect(result.source).toBe('env.KB_BASE')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/dogfood/documents')
  })

  it('Given no session/default/env base, then resolution throws explicit error', async () => {
    delete process.env.KB_BASE

    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(
      'No KB base configured',
    )
  })

  it('Given use command output, then includes session and fallback guidance', () => {
    const text = formatUseCommandHelp('dogfood', '/repo/sessions/namespaces/dogfood/documents')
    expect(text).toContain('Saved as session base for immediate invocations.')
    expect(text).toContain('KB_BASE=dogfood')
  })
})
