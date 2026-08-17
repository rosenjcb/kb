import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteBase,
  ensureOperationalBaseDir,
  formatDeleteBaseResult,
  formatUseCommandHelp,
  getKbHomeDir,
  listAllBases,
  readBaseConfig,
  readOptionalCliValue,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  resolveKbStorageDirFromArgs,
  stripCliFlagWithValue,
  writeSessionBase,
} from '@kb/core/storage/base-selection.js'
import { CLI_ERROR_NO_KB_BASE } from '@kb/core/config/cli-prerequisites.js'

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

  it('[TC-1AL2] alias base resolves to namespaced sessions directory', () => {
    const dir = resolveBaseToDir('dogfood', '/repo')
    expect(dir).toBe(path.join(getKbHomeDir(), 'sessions', 'dogfood'))
  })

  it('[TC-55NE] path-like base resolves relative to cwd', () => {
    expect(resolveBaseToDir('./tmp/docs', '/repo')).toBe('/repo/tmp/docs')
  })

  it('[TC-UNMV] absolute path base is returned as-is', () => {
    expect(resolveBaseToDir('/data/kb', '/repo')).toBe('/data/kb')
  })

  // ─── resolveEffectiveBaseDir — active base only ───────────────────────────

  it('[TC-YRYL] resolves the active base from config', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      activeBase: 'session-base',
    })

    expect(result.source).toBe('activeBase')
    expect(result.baseName).toBe('session-base')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'session-base'))
  })

  it('[TC-DH7S] throws when no activeBase is set (server default takes over)', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(CLI_ERROR_NO_KB_BASE)
  })

  // ─── writeSessionBase / readBaseConfig ───────────────────────────────────

  it('[TC-IIKB] writeSessionBase persists the active base', async () => {
    await writeSessionBase('catalog')

    const config = await readBaseConfig()

    expect(config.activeBase).toBe('catalog')
    const raw = await readFile(path.join(getKbHomeDir(), 'state', 'active-base'), 'utf8')
    expect(raw.trim()).toBe('catalog')
  })

  it('[TC-S9NT] migrates legacy session.json into active-base and removes session.json', async () => {
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

  it('[TC-DL0O] ensureOperationalBaseDir migrates legacy repo sqlite into KB home', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kb-repo-'))
    const legacyDir = path.join(cwd, 'sessions', 'namespaces', 'catalog', 'documents')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, '.kb-index.sqlite'), 'sqlite-bytes', 'utf8')

    const resolved = await ensureOperationalBaseDir('catalog', cwd)

    expect(resolved).toBe(path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(await readFile(path.join(resolved, '.kb-index.sqlite'), 'utf8')).toBe('sqlite-bytes')

    await rm(cwd, { recursive: true, force: true })
  })

  it('[TC-1BXW] ensureOperationalBaseDir migrates legacy KB home base directory into sessions namespace', async () => {
    const legacyBaseDir = path.join(getKbHomeDir(), 'dogfood')
    await mkdir(path.join(legacyBaseDir, 'checkpoints'), { recursive: true })
    await writeFile(path.join(legacyBaseDir, '.kb-index.sqlite'), 'sqlite-bytes', 'utf8')
    await writeFile(
      path.join(legacyBaseDir, 'checkpoints', 'init-latest.checkpoint.json'),
      '{"version":2}\n',
      'utf8'
    )

    const resolved = await ensureOperationalBaseDir('dogfood')

    expect(resolved).toBe(path.join(getKbHomeDir(), 'sessions', 'dogfood'))
    expect(await readFile(path.join(resolved, '.kb-index.sqlite'), 'utf8')).toBe('sqlite-bytes')
    expect(
      await readFile(path.join(resolved, 'checkpoints', 'init-latest.checkpoint.json'), 'utf8')
    ).toContain('"version":2')
    await expect(
      readFile(path.join(getKbHomeDir(), 'dogfood', '.kb-index.sqlite'), 'utf8')
    ).rejects.toThrow()
  })

  // ─── format helpers ───────────────────────────────────────────────────────

  it('[TC-Q3X2] formatUseCommandHelp shows active session switching', () => {
    const text = formatUseCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Using base: catalog')
    expect(text).toContain('Switched the active base for this session')
  })
})

describe('deleteBase', () => {
  let tempKbHome: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-home-del-'))
    process.env.KB_HOME = tempKbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    await rm(tempKbHome, { recursive: true, force: true })
  })

  it('[TC-QD3M] Given an existing named base, then deletes its session directory', async () => {
    const baseDir = await ensureOperationalBaseDir('to-delete')
    await writeFile(path.join(baseDir, 'marker.txt'), 'data')

    const result = await deleteBase('to-delete')

    expect(result.basePath).toContain('to-delete')
    expect(result.purgedPaths.some(p => p.includes(path.join('sessions', 'to-delete')))).toBe(true)
    await expect(readFile(path.join(baseDir, 'marker.txt'), 'utf8')).rejects.toThrow()
  })

  it('[TC-LANX] Given legacy + tmp checkpoint artifacts, then purges them too', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kb-repo-del-'))
    const legacyBaseDir = path.join(getKbHomeDir(), 'dogfood')
    const tmpCheckpoint = path.join(cwd, '.tmp', 'kb-init', 'dogfood-latest.checkpoint.json')
    await mkdir(legacyBaseDir, { recursive: true })
    await mkdir(path.dirname(tmpCheckpoint), { recursive: true })
    await writeFile(path.join(legacyBaseDir, 'legacy.txt'), 'legacy')
    await writeFile(tmpCheckpoint, '{"version":2}\n')

    const result = await deleteBase('dogfood', cwd)

    expect(result.purgedPaths).toContain(legacyBaseDir)
    expect(result.purgedPaths).toContain(tmpCheckpoint)
    await expect(readFile(path.join(legacyBaseDir, 'legacy.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(tmpCheckpoint, 'utf8')).rejects.toThrow()
    await rm(cwd, { recursive: true, force: true })
  })

  it('[TC-E8OQ] Given the base is the active base, then clears it from config', async () => {
    await ensureOperationalBaseDir('active-base')
    await writeSessionBase('active-base')

    const before = await readBaseConfig()
    expect(before.activeBase).toBe('active-base')

    const result = await deleteBase('active-base')

    expect(result.clearedActive).toBe(true)
    const after = await readBaseConfig()
    expect(after.activeBase).toBeUndefined()
  })

  it('[TC-TFPC] Given the base does not exist on disk, then succeeds without error', async () => {
    await expect(deleteBase('nonexistent-base')).resolves.toBeDefined()
  })

  it('[TC-EJOW] Given a path-like base, then throws rather than deleting arbitrary paths', async () => {
    await expect(deleteBase('/tmp/some-dir')).rejects.toThrow('named bases')
  })
})

describe('formatDeleteBaseResult', () => {
  it('[TC-O7OU] includes the base name and path in output', () => {
    const result = {
      basePath: '/tmp/sessions/test',
      clearedActive: false,
      purgedPaths: [],
    }
    const text = formatDeleteBaseResult('test', result)
    expect(text).toContain('Deleted base: test')
    expect(text).toContain('/tmp/sessions/test')
  })

  it('[TC-CW47] mentions cleared active base when applicable', () => {
    const result = {
      basePath: '/tmp/sessions/test',
      clearedActive: true,
      purgedPaths: [],
    }
    const text = formatDeleteBaseResult('test', result)
    expect(text).toContain('activeBase')
  })
})

describe('listAllBases', () => {
  let tempKbHome: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-list-'))
    process.env.KB_HOME = tempKbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    await rm(tempKbHome, { recursive: true, force: true })
  })

  it('[TC-TVMB] returns empty array when sessions directory does not exist', async () => {
    const bases = await listAllBases()
    expect(bases).toEqual([])
  })

  it('[TC-NG7P] returns only directories that contain .kb-index.sqlite', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    await mkdir(path.join(sessionsDir, 'initialized'), { recursive: true })
    await writeFile(path.join(sessionsDir, 'initialized', '.kb-index.sqlite'), '', 'utf8')
    await mkdir(path.join(sessionsDir, 'empty'), { recursive: true })

    const bases = await listAllBases()
    expect(bases).toHaveLength(1)
    expect(bases[0].name).toBe('initialized')
  })

  it('[TC-1GXA] marks the active base correctly', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    for (const name of ['alpha', 'beta', 'gamma']) {
      await mkdir(path.join(sessionsDir, name), { recursive: true })
      await writeFile(path.join(sessionsDir, name, '.kb-index.sqlite'), '', 'utf8')
    }
    await writeSessionBase('beta')

    const bases = await listAllBases()
    const byName = Object.fromEntries(bases.map(b => [b.name, b]))

    expect(byName.alpha.isActive).toBe(false)
    expect(byName.beta.isActive).toBe(true)
    expect(byName.gamma.isActive).toBe(false)
  })

  it('[TC-EA5G] returns bases sorted alphabetically', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    for (const name of ['zebra', 'apple', 'mango']) {
      await mkdir(path.join(sessionsDir, name), { recursive: true })
      await writeFile(path.join(sessionsDir, name, '.kb-index.sqlite'), '', 'utf8')
    }
    const bases = await listAllBases()
    expect(bases.map(b => b.name)).toEqual(['apple', 'mango', 'zebra'])
  })
})

describe('resolveEffectiveBaseDir', () => {
  let tempKbHome: string
  let tempDir: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-eff-'))
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-project-'))
    process.env.KB_HOME = tempKbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    await rm(tempKbHome, { recursive: true, force: true })
    await rm(tempDir, { recursive: true, force: true })
  })

  it('[TC-XXX9] resolves the configured active base', async () => {
    await writeSessionBase('session-base')

    const result = await resolveEffectiveBaseDir(tempDir)

    expect(result.source).toBe('activeBase')
    expect(result.baseName).toBe('session-base')
  })

  it('[TC-EHQA] throws when no active base is configured', async () => {
    await expect(resolveEffectiveBaseDir(tempDir)).rejects.toThrow(CLI_ERROR_NO_KB_BASE)
  })
})

describe('CLI argv helpers (--base)', () => {
  let tempKbHome: string

  beforeEach(async () => {
    tempKbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-home-cli-'))
    process.env.KB_HOME = tempKbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    await rm(tempKbHome, { recursive: true, force: true })
  })

  it('[TC-OHPZ] readOptionalCliValue returns the following token', () => {
    expect(readOptionalCliValue(['--base', 'dogfood', 'x'], '--base')).toBe('dogfood')
    expect(readOptionalCliValue(['x', '--base', 'b'], '--base')).toBe('b')
  })

  it('[TC-CVIS] readOptionalCliValue returns undefined when flag or value is missing', () => {
    expect(readOptionalCliValue(['--other'], '--base')).toBeUndefined()
    expect(readOptionalCliValue(['--base'], '--base')).toBeUndefined()
    expect(readOptionalCliValue(['--base', '--apply'], '--base')).toBeUndefined()
  })

  it('[TC-MHT9] stripCliFlagWithValue removes --base and its value', () => {
    expect(
      stripCliFlagWithValue(['graph', '--base', 'dogfood', '--entity', 'KB'], '--base')
    ).toEqual(['graph', '--entity', 'KB'])
  })

  it('[TC-1G6A] resolveKbStorageDirFromArgs honors --base over active session', async () => {
    await ensureOperationalBaseDir('session-a')
    await ensureOperationalBaseDir('session-b')
    await writeSessionBase('session-a')

    const dir = await resolveKbStorageDirFromArgs(['--base', 'session-b', '--format', 'json'])
    expect(dir).toBe(path.join(tempKbHome, 'sessions', 'session-b'))
  })

  it('[TC-8ODE] resolveKbStorageDirFromArgs falls back to effective base when --base omitted', async () => {
    await ensureOperationalBaseDir('only-one')
    await writeSessionBase('only-one')

    const dir = await resolveKbStorageDirFromArgs(['graph', '--format', 'json'], tempKbHome)
    expect(dir).toBe(path.join(tempKbHome, 'sessions', 'only-one'))
  })
})
