import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { CLI_ERROR_NO_KB_BASE } from '../../src/cli/cli-prerequisites'

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

  it('active base in config wins over selectedBase', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      activeBase: 'session-base',
      selectedBase: 'config-base',
    })

    expect(result.source).toBe('config.activeBase')
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
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(CLI_ERROR_NO_KB_BASE)
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
    const raw = JSON.parse(await readFile(path.join(getKbHomeDir(), 'config.json'), 'utf8')) as {
      activeBase?: string
      selectedBase?: string
    }
    expect(raw.activeBase).toBe('catalog')
    expect(raw.selectedBase).toBe('dogfood')
  })

  it('migrates legacy session.json into config.json and removes session.json', async () => {
    await writeFile(
      path.join(getKbHomeDir(), 'session.json'),
      `${JSON.stringify({ activeBase: 'legacy-base' }, null, 2)}\n`,
      'utf8'
    )
    const config = await readBaseConfig()
    expect(config.activeBase).toBe('legacy-base')
    await expect(readFile(path.join(getKbHomeDir(), 'session.json'), 'utf8')).rejects.toThrow()
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

  it('ensureOperationalBaseDir migrates legacy KB home base directory into sessions namespace', async () => {
    const legacyBaseDir = path.join(getKbHomeDir(), 'dogfood')
    await mkdir(path.join(legacyBaseDir, 'checkpoints'), { recursive: true })
    await writeFile(path.join(legacyBaseDir, '.kb-index.sqlite'), 'sqlite-bytes', 'utf8')
    await writeFile(path.join(legacyBaseDir, '.kb-graph.duckdb'), 'duckdb-bytes', 'utf8')
    await writeFile(
      path.join(legacyBaseDir, 'checkpoints', 'init-latest.checkpoint.json'),
      '{"version":2}\n',
      'utf8'
    )

    const resolved = await ensureOperationalBaseDir('dogfood')

    expect(resolved).toBe(path.join(getKbHomeDir(), 'sessions', 'dogfood'))
    expect(await readFile(path.join(resolved, '.kb-index.sqlite'), 'utf8')).toBe('sqlite-bytes')
    expect(await readFile(path.join(resolved, '.kb-graph.duckdb'), 'utf8')).toBe('duckdb-bytes')
    expect(
      await readFile(path.join(resolved, 'checkpoints', 'init-latest.checkpoint.json'), 'utf8')
    ).toContain('"version":2')
    await expect(
      readFile(path.join(getKbHomeDir(), 'dogfood', '.kb-index.sqlite'), 'utf8')
    ).rejects.toThrow()
  })

  // ─── format helpers ───────────────────────────────────────────────────────

  it('formatUseCommandHelp shows active session switching', () => {
    const text = formatUseCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Using base: catalog')
    expect(text).toContain('Switched the active base for this session')
    expect(text).toContain('`kb use --default <base>`')
  })

  it('formatDefaultCommandHelp shows persistent default messaging', () => {
    const text = formatDefaultCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog')
    )
    expect(text).toContain('Default base: catalog')
    expect(text).toContain('preferred base')
    expect(text).toContain('`kb use <base>`')
  })

  it('formatUseCommandHelp uses slash hints in TUI mode', () => {
    const text = formatUseCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog'),
      'tui'
    )
    expect(text).toContain('`/use --default <base>`')
  })

  it('formatDefaultCommandHelp uses slash hints in TUI mode', () => {
    const text = formatDefaultCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog'),
      'tui'
    )
    expect(text).toContain('`/use <base>`')
  })
})
