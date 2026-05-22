import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteBase,
  ensureOperationalBaseDir,
  findKbFile,
  formatDefaultCommandHelp,
  formatDeleteBaseResult,
  formatUseCommandHelp,
  getKbHomeDir,
  listAllBases,
  printBaseDeleteHelp,
  readBaseConfig,
  readOptionalCliValue,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  resolveKbStorageDirFromArgs,
  stripCliFlagWithValue,
  writeDefaultBase,
  writeKbFile,
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

  it('active base in config wins over defaultBase', async () => {
    const result = await resolveEffectiveBaseDir('/repo', {
      activeBase: 'session-base',
      defaultBase: 'config-base',
    })

    expect(result.source).toBe('config.activeBase')
    expect(result.baseName).toBe('session-base')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'session-base'))
  })

  it('config.defaultBase is used when KB_BASE is not set', async () => {
    const result = await resolveEffectiveBaseDir('/repo', { defaultBase: 'catalog' })

    expect(result.source).toBe('config.defaultBase')
    expect(result.baseName).toBe('catalog')
    expect(result.baseDir).toBe(path.join(getKbHomeDir(), 'sessions', 'catalog'))
  })

  it('throws when neither activeBase nor config.defaultBase is set', async () => {
    await expect(resolveEffectiveBaseDir('/repo', {})).rejects.toThrow(CLI_ERROR_NO_KB_BASE)
  })

  // ─── writeDefaultBase / writeSessionBase / readBaseConfig ────────────────

  it('writeDefaultBase persists to config and readBaseConfig reads it back', async () => {
    await writeDefaultBase('dogfood')
    const config = await readBaseConfig()
    expect(config.defaultBase).toBe('dogfood')
  })

  it('writeDefaultBase overwrites a prior default', async () => {
    await writeDefaultBase('dogfood')
    await writeDefaultBase('my-project')
    const config = await readBaseConfig()
    expect(config.defaultBase).toBe('my-project')
  })

  it('writeSessionBase persists the active base separately from the default', async () => {
    await writeDefaultBase('dogfood')
    await writeSessionBase('catalog')

    const config = await readBaseConfig()

    expect(config.defaultBase).toBe('dogfood')
    expect(config.activeBase).toBe('catalog')
    const raw = JSON.parse(await readFile(path.join(getKbHomeDir(), 'config.json'), 'utf8')) as {
      activeBase?: string
      defaultBase?: string
    }
    expect(raw.activeBase).toBe('catalog')
    expect(raw.defaultBase).toBe('dogfood')
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

  it('formatUseCommandHelp shows active session switching', () => {
    const text = formatUseCommandHelp('catalog', path.join(getKbHomeDir(), 'sessions', 'catalog'))
    expect(text).toContain('Using base: catalog')
    expect(text).toContain('Switched the active base for this session')
    expect(text).toContain('`kb base use --default <base>`')
  })

  it('formatDefaultCommandHelp shows persistent default messaging', () => {
    const text = formatDefaultCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog')
    )
    expect(text).toContain('Default base: catalog')
    expect(text).toContain('preferred base')
    expect(text).toContain('`kb base use <base>`')
  })

  it('formatUseCommandHelp uses slash hints in TUI mode', () => {
    const text = formatUseCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog'),
      'tui'
    )
    expect(text).toContain('`/base use --default <base>`')
  })

  it('formatDefaultCommandHelp uses slash hints in TUI mode', () => {
    const text = formatDefaultCommandHelp(
      'catalog',
      path.join(getKbHomeDir(), 'sessions', 'catalog'),
      'tui'
    )
    expect(text).toContain('`/base use <base>`')
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

  it('Given an existing named base, then deletes its session directory', async () => {
    const baseDir = await ensureOperationalBaseDir('to-delete')
    await writeFile(path.join(baseDir, 'marker.txt'), 'data')

    const result = await deleteBase('to-delete')

    expect(result.basePath).toContain('to-delete')
    expect(result.purgedPaths.some(p => p.includes(path.join('sessions', 'to-delete')))).toBe(true)
    await expect(readFile(path.join(baseDir, 'marker.txt'), 'utf8')).rejects.toThrow()
  })

  it('Given legacy + tmp checkpoint artifacts, then purges them too', async () => {
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

  it('Given the base is the active base, then clears it from config', async () => {
    await ensureOperationalBaseDir('active-base')
    await writeSessionBase('active-base')

    const before = await readBaseConfig()
    expect(before.activeBase).toBe('active-base')

    const result = await deleteBase('active-base')

    expect(result.clearedActive).toBe(true)
    const after = await readBaseConfig()
    expect(after.activeBase).toBeUndefined()
  })

  it('Given the base is the selected (default) base, then clears it from config', async () => {
    await ensureOperationalBaseDir('default-base')
    await writeDefaultBase('default-base')

    const result = await deleteBase('default-base')

    expect(result.clearedSelected).toBe(true)
    const after = await readBaseConfig()
    expect(after.defaultBase).toBeUndefined()
  })

  it('Given the base does not exist on disk, then succeeds without error', async () => {
    await expect(deleteBase('nonexistent-base')).resolves.toBeDefined()
  })

  it('Given a path-like base, then throws rather than deleting arbitrary paths', async () => {
    await expect(deleteBase('/tmp/some-dir')).rejects.toThrow('named bases')
  })
})

describe('printBaseDeleteHelp', () => {
  it('includes base delete usage in CLI mode', () => {
    const text = printBaseDeleteHelp('cli')
    expect(text).toContain('kb base delete')
    expect(text).toContain('--force')
  })

  it('includes base delete usage in TUI mode', () => {
    const text = printBaseDeleteHelp('tui')
    expect(text).toContain('/base delete')
  })
})

describe('formatDeleteBaseResult', () => {
  it('includes the base name and path in output', () => {
    const result = {
      basePath: '/tmp/sessions/test',
      clearedActive: false,
      clearedSelected: false,
      purgedPaths: [],
    }
    const text = formatDeleteBaseResult('test', result)
    expect(text).toContain('Deleted base: test')
    expect(text).toContain('/tmp/sessions/test')
  })

  it('mentions cleared active base when applicable', () => {
    const result = {
      basePath: '/tmp/sessions/test',
      clearedActive: true,
      clearedSelected: false,
      purgedPaths: [],
    }
    const text = formatDeleteBaseResult('test', result)
    expect(text).toContain('activeBase')
  })

  it('mentions cleared default base when applicable', () => {
    const result = {
      basePath: '/tmp/sessions/test',
      clearedActive: false,
      clearedSelected: true,
      purgedPaths: [],
    }
    const text = formatDeleteBaseResult('test', result)
    expect(text).toContain('defaultBase')
  })
})

describe('findKbFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-find-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns the base name from a .kb file in the given directory', async () => {
    await writeFile(path.join(tempDir, '.kb'), 'mybase\n', 'utf8')
    expect(await findKbFile(tempDir)).toBe('mybase')
  })

  it('finds a .kb file in an ancestor directory', async () => {
    await writeFile(path.join(tempDir, '.kb'), 'ancestorbase\n', 'utf8')
    const nested = path.join(tempDir, 'a', 'b', 'c')
    await mkdir(nested, { recursive: true })
    expect(await findKbFile(nested)).toBe('ancestorbase')
  })

  it('returns null when no .kb file exists in any ancestor', async () => {
    const nested = path.join(tempDir, 'x', 'y')
    await mkdir(nested, { recursive: true })
    // tempDir itself has no .kb file
    expect(await findKbFile(nested)).toBeNull()
  })

  it('trims whitespace from the base name', async () => {
    await writeFile(path.join(tempDir, '.kb'), '  spaced-base  \n', 'utf8')
    expect(await findKbFile(tempDir)).toBe('spaced-base')
  })

  it('returns null when .kb file is empty', async () => {
    await writeFile(path.join(tempDir, '.kb'), '   \n', 'utf8')
    expect(await findKbFile(tempDir)).toBeNull()
  })
})

describe('writeKbFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-write-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes a .kb file containing the base name', async () => {
    await writeKbFile(tempDir, 'mybase')
    const contents = await readFile(path.join(tempDir, '.kb'), 'utf8')
    expect(contents.trim()).toBe('mybase')
  })

  it('overwrites an existing .kb file', async () => {
    await writeKbFile(tempDir, 'first')
    await writeKbFile(tempDir, 'second')
    const contents = await readFile(path.join(tempDir, '.kb'), 'utf8')
    expect(contents.trim()).toBe('second')
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

  it('returns empty array when sessions directory does not exist', async () => {
    const bases = await listAllBases()
    expect(bases).toEqual([])
  })

  it('returns only directories that contain .kb-index.sqlite', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    await mkdir(path.join(sessionsDir, 'initialized'), { recursive: true })
    await writeFile(path.join(sessionsDir, 'initialized', '.kb-index.sqlite'), '', 'utf8')
    await mkdir(path.join(sessionsDir, 'empty'), { recursive: true })

    const bases = await listAllBases()
    expect(bases).toHaveLength(1)
    expect(bases[0].name).toBe('initialized')
  })

  it('marks the active and default bases correctly', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    for (const name of ['alpha', 'beta', 'gamma']) {
      await mkdir(path.join(sessionsDir, name), { recursive: true })
      await writeFile(path.join(sessionsDir, name, '.kb-index.sqlite'), '', 'utf8')
    }
    await writeSessionBase('beta')
    await writeDefaultBase('gamma')

    const bases = await listAllBases()
    const byName = Object.fromEntries(bases.map(b => [b.name, b]))

    expect(byName.alpha.isActive).toBe(false)
    expect(byName.alpha.isDefault).toBe(false)
    expect(byName.beta.isActive).toBe(true)
    expect(byName.beta.isDefault).toBe(false)
    expect(byName.gamma.isActive).toBe(false)
    expect(byName.gamma.isDefault).toBe(true)
  })

  it('returns bases sorted alphabetically', async () => {
    const sessionsDir = path.join(tempKbHome, 'sessions')
    for (const name of ['zebra', 'apple', 'mango']) {
      await mkdir(path.join(sessionsDir, name), { recursive: true })
      await writeFile(path.join(sessionsDir, name, '.kb-index.sqlite'), '', 'utf8')
    }
    const bases = await listAllBases()
    expect(bases.map(b => b.name)).toEqual(['apple', 'mango', 'zebra'])
  })
})

describe('resolveEffectiveBaseDir with .kb file', () => {
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

  it('uses .kb file when no activeBase or defaultBase is configured', async () => {
    await writeKbFile(tempDir, 'project-base')
    const sessionsDir = path.join(tempKbHome, 'sessions', 'project-base')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(path.join(sessionsDir, '.kb-index.sqlite'), '', 'utf8')

    const result = await resolveEffectiveBaseDir(tempDir)

    expect(result.source).toBe('directory:.kb')
    expect(result.baseName).toBe('project-base')
  })

  it('.kb file takes priority over config.activeBase', async () => {
    await writeKbFile(tempDir, 'project-base')
    const sessionsDir = path.join(tempKbHome, 'sessions', 'project-base')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(path.join(sessionsDir, '.kb-index.sqlite'), '', 'utf8')
    // also set an activeBase in config — .kb should win
    await writeSessionBase('session-base')

    const result = await resolveEffectiveBaseDir(tempDir)

    expect(result.source).toBe('directory:.kb')
    expect(result.baseName).toBe('project-base')
  })

  it('falls back to config.activeBase when no .kb file is found', async () => {
    await writeSessionBase('session-base')

    const result = await resolveEffectiveBaseDir(tempDir)

    expect(result.source).toBe('config.activeBase')
    expect(result.baseName).toBe('session-base')
    // resolveEffectiveBaseDir does NOT write .kb — only scan/init do
    expect(await findKbFile(tempDir)).toBeNull()
  })

  it('falls back to config.defaultBase when no .kb file and no activeBase', async () => {
    await writeDefaultBase('default-base')

    const result = await resolveEffectiveBaseDir(tempDir)

    expect(result.source).toBe('config.defaultBase')
    expect(result.baseName).toBe('default-base')
    expect(await findKbFile(tempDir)).toBeNull()
  })

  it('finds .kb file from a subdirectory via ancestor walk', async () => {
    await writeKbFile(tempDir, 'ancestor-base')
    const sessionsDir = path.join(tempKbHome, 'sessions', 'ancestor-base')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(path.join(sessionsDir, '.kb-index.sqlite'), '', 'utf8')

    const nestedDir = path.join(tempDir, 'src', 'lib')
    await mkdir(nestedDir, { recursive: true })

    const result = await resolveEffectiveBaseDir(nestedDir)

    expect(result.source).toBe('directory:.kb')
    expect(result.baseName).toBe('ancestor-base')
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

  it('readOptionalCliValue returns the following token', () => {
    expect(readOptionalCliValue(['--base', 'dogfood', 'x'], '--base')).toBe('dogfood')
    expect(readOptionalCliValue(['x', '--base', 'b'], '--base')).toBe('b')
  })

  it('readOptionalCliValue returns undefined when flag or value is missing', () => {
    expect(readOptionalCliValue(['--other'], '--base')).toBeUndefined()
    expect(readOptionalCliValue(['--base'], '--base')).toBeUndefined()
    expect(readOptionalCliValue(['--base', '--apply'], '--base')).toBeUndefined()
  })

  it('stripCliFlagWithValue removes --base and its value', () => {
    expect(
      stripCliFlagWithValue(['graph', '--base', 'dogfood', '--entity', 'KB'], '--base')
    ).toEqual(['graph', '--entity', 'KB'])
  })

  it('resolveKbStorageDirFromArgs honors --base over active session', async () => {
    await ensureOperationalBaseDir('session-a')
    await ensureOperationalBaseDir('session-b')
    await writeSessionBase('session-a')

    const dir = await resolveKbStorageDirFromArgs(['--base', 'session-b', '--format', 'json'])
    expect(dir).toBe(path.join(tempKbHome, 'sessions', 'session-b'))
  })

  it('resolveKbStorageDirFromArgs falls back to effective base when --base omitted', async () => {
    await ensureOperationalBaseDir('only-one')
    await writeSessionBase('only-one')

    // Pass tempKbHome as cwd so findKbFile does not walk into the real project tree
    const dir = await resolveKbStorageDirFromArgs(['graph', '--format', 'json'], tempKbHome)
    expect(dir).toBe(path.join(tempKbHome, 'sessions', 'only-one'))
  })
})
