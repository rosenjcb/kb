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

  it('Given KB_BASE_DIR set, then effective resolution uses it first', async () => {
    process.env.KB_BASE_DIR = './custom/path'
    process.env.KB_BASE = 'dogfood'

    const result = await resolveEffectiveBaseDir('/repo')

    expect(result.source).toBe('env.KB_BASE_DIR')
    expect(result.baseDir).toBe('/repo/custom/path')
  })

  it('Given KB_BASE set, then effective resolution uses alias mapping', async () => {
    delete process.env.KB_BASE_DIR
    process.env.KB_BASE = 'dogfood'

    const result = await resolveEffectiveBaseDir('/repo')

    expect(result.source).toBe('env.KB_BASE')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/dogfood/documents')
  })

  it('Given no env and no config, then falls back to default namespaced directory', async () => {
    delete process.env.KB_BASE_DIR
    delete process.env.KB_BASE

    const result = await resolveEffectiveBaseDir('/repo', {})

    expect(result.source).toBe('fallback')
    expect(result.baseDir).toBe('/repo/sessions/namespaces/default/documents')
  })

  it('Given use command output, then includes shell guidance', () => {
    const text = formatUseCommandHelp('dogfood', '/repo/sessions/namespaces/dogfood/documents')
    expect(text).toContain('export KB_BASE="dogfood"')
  })
})
