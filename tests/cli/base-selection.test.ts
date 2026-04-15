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

  it('Given selectedBase set, then effective resolution uses it', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      selectedBase: 'catalog',
    })

    expect(result.source).toBe('config.selectedBase')
    expect(result.baseName).toBe('catalog')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/catalog/documents')
  })

  it('Given no selected base, then resolution throws explicit error', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(
      'No KB base configured',
    )
  })

  it('Given use command output, then it describes the selected base model', () => {
    const text = formatUseCommandHelp('catalog', '/repo/sessions/namespaces/catalog/documents')
    expect(text).toContain('Selected base: catalog')
    expect(text).toContain('interchangeably')
  })

  it('Given default command output, then it describes the selected base model', () => {
    const text = formatDefaultCommandHelp('catalog', '/repo/sessions/namespaces/catalog/documents')
    expect(text).toContain('Selected base: catalog')
    expect(text).toContain('interchangeably')
  })
})
