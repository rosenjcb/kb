import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  formatDefaultCommandHelp,
  formatUseCommandHelp,
} from '../../src/cli/base-selection'

describe('base-selection', () => {
  afterEach(() => {
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
    const result = await resolveEffectiveBaseDir('/repo', {
      sessionBase: 'session-base',
      defaultBase: 'default-base',
    })

    expect(result.source).toBe('config.sessionBase')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/session-base/documents')
  })

  it('Given defaultBase set and no sessionBase, then effective resolution uses default', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      defaultBase: 'dogfood',
    })

    expect(result.source).toBe('config.defaultBase')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/dogfood/documents')
  })

  it('Given no session/default base, then resolution throws explicit error', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(
      'No KB base configured',
    )
  })

  it('Given use command output, then includes session and fallback guidance', () => {
    const text = formatUseCommandHelp('dogfood', '/repo/sessions/namespaces/dogfood/documents')
    expect(text).toContain('Saved as session base for immediate invocations.')
    expect(text).toContain('kb default dogfood')
  })

  it('Given default command output, then it states default also becomes active immediately', () => {
    const text = formatDefaultCommandHelp('catalog', '/repo/sessions/namespaces/catalog/documents')
    expect(text).toContain('Saved as the active base for immediate invocations too.')
  })

  it('Given defaultBase updates current base too, then stale sessionBase no longer overrides it', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      defaultBase: 'catalog',
      sessionBase: 'catalog',
    })

    expect(result.source).toBe('config.sessionBase')
    expect(result.baseName).toBe('catalog')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/catalog/documents')
  })
})
