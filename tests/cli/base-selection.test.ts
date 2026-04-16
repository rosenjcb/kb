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
  writeSessionBase,
} from '../../src/cli/base-selection'

describe('base-selection', () => {
  let tempKbHome: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-home-'))
    process.env.KB_HOME = tempKbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
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

  // ─── resolveEffectiveBaseDir — session/config precedence ──────────────────

  it('active session base wins over config.selectedBase', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      activeBase: 'session-base',
      selectedBase: 'config-base',
    })

    expect(result.source).toBe('session.activeBase')
    expect(result.baseName).toBe('session-base')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'session-base'))
  })

  it('config.selectedBase is used when KB_BASE is not set', async () => {
    const result = await resolveEffectiveBaseDir('/repo', { selectedBase: 'catalog' })

    expect(result.source).toBe('config.selectedBase')
    expect(result.baseName).toBe('catalog')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'catalog'))
  })

  it('throws when neither activeBase nor config.selectedBase is set', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(
      'No KB base configured',
    )
  })

  // ─── writeDefaultBase / writeSessionBase / readBaseConfig ────────────────

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

  it('writeSessionBase persists the active base separately from the default', async () => {
    await writeDefaultBase('dogfood')
    await writeSessionBase('catalog')

    const config = await readBaseConfig()

    expect(config.selectedBase).toBe('dogfood')
    expect(config.activeBase).toBe('catalog')
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

  it('formatUseCommandHelp shows active session switching', () => {
    const text = formatUseCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Using base: catalog')
    expect(text).toContain('Switched the active base for this session')
  })

  it('formatDefaultCommandHelp shows persistent default messaging', () => {
    const text = formatDefaultCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Default base: catalog')
    expect(text).toContain('preferred base')
  })
})
