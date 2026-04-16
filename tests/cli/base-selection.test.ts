import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureOperationalBaseDir,
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  getKbHomeDir,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  writeDefaultBase,
} from '../../src/cli/base-selection'

describe('base-selection', () => {
  let tempKbHome: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-home-'))
    process.env.KB_HOME = tempKbHome
    delete process.env.KB_BASE
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    delete process.env.KB_BASE
    await rm(tempKbHome, { recursive: true, force: true })
  })

  // ─── resolveBaseToDir ─────────────────────────────────────────────────────

  it('alias base resolves to namespaced sessions directory', () => {
    const dir = resolveBaseToDir('dogfood', '/repo')
    expect(dir).toBe(path.join(getKbHomeDir(), 'sessions', 'dogfood'))
  })

  it('path-like base resolves relative to cwd', () => {
    expect(resolveBaseToDir('./tmp/docs', '/repo')).toBe('/repo/tmp/docs')
  })

  it('absolute path base is returned as-is', () => {
    expect(resolveBaseToDir('/data/kb', '/repo')).toBe('/data/kb')
  })

  // ─── resolveEffectiveBaseDir — env.KB_BASE ────────────────────────────────

  it('KB_BASE env var is respected and wins over config', async () => {
    process.env.KB_BASE = 'env-base'
    const result = await resolveEffectiveBaseDir('/repo', { selectedBase: 'config-base' })

    expect(result.source).toBe('env.KB_BASE')
    expect(result.baseName).toBe('env-base')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'env-base'))
  })

  it('KB_BASE env var with no config still resolves', async () => {
    process.env.KB_BASE = 'env-only'
    const result = await resolveEffectiveBaseDir('/repo', {})

    expect(result.source).toBe('env.KB_BASE')
    expect(result.baseName).toBe('env-only')
  })

  // ─── resolveEffectiveBaseDir — config.selectedBase ───────────────────────

  it('config.selectedBase is used when KB_BASE is not set', async () => {
    const result = await resolveEffectiveBaseDir('/repo', { selectedBase: 'catalog' })

    expect(result.source).toBe('config.selectedBase')
    expect(result.baseName).toBe('catalog')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'catalog'))
  })

  it('throws when neither KB_BASE nor config.selectedBase is set', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(
      'No KB base configured',
    )
  })

  // ─── writeDefaultBase / readBaseConfig ───────────────────────────────────

  it('writeDefaultBase persists to config and readBaseConfig reads it back', async () => {
    await writeDefaultBase('dogfood')
    const config = await readBaseConfig()
    expect(config.selectedBase).toBe('dogfood')
  })

  it('writeDefaultBase overwrites a prior default', async () => {
    await writeDefaultBase('dogfood')
    await writeDefaultBase('my-project')
    const config = await readBaseConfig()
    expect(config.selectedBase).toBe('my-project')
  })

  // ─── session isolation ────────────────────────────────────────────────────

  it('KB_BASE in one env does not bleed into another (env is cleaned up)', async () => {
    process.env.KB_BASE = 'session-a'
    const first = await resolveEffectiveBaseDir('/repo', {})
    expect(first.baseName).toBe('session-a')

    delete process.env.KB_BASE
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow('No KB base configured')
  })

  // ─── legacy sqlite migration ──────────────────────────────────────────────

  it('ensureOperationalBaseDir migrates legacy repo sqlite into KB home', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kb-repo-'))
    const legacyDir = path.join(cwd, 'sessions', 'namespaces', 'catalog', 'documents')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, '.kb-index.sqlite'), 'sqlite-bytes', 'utf8')

    const resolved = await ensureOperationalBaseDir('catalog', cwd)

    expect(resolved).toBe(path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(await readFile(path.join(resolved, '.kb-index.sqlite'), 'utf8')).toBe('sqlite-bytes')

    await rm(cwd, { recursive: true, force: true })
  })

  // ─── format helpers ───────────────────────────────────────────────────────

  it('formatUseCommandHelp shows export instruction', () => {
    const text = formatUseCommandHelp('catalog')
    expect(text).toContain('export KB_BASE=catalog')
    expect(text).toContain('cleared when you close it')
  })

  it('formatDefaultCommandHelp shows persistent default messaging', () => {
    const text = formatDefaultCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Default base: catalog')
    expect(text).toContain('persistent default')
  })
})
