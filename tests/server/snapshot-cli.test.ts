import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readSnapshotManifest } from '@kb/core/storage/snapshot.js'
import type { ServerLogger } from '@kb/server/server-cli.js'
import { adoptSnapshot, runExportCommand, runImportCommand } from '@kb/server/snapshot-cli.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

function capturingLogger(): { logger: ServerLogger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: { log: m => lines.push(m), error: m => lines.push(m) },
  }
}

/** Write a small but real SQLite index so VACUUM INTO has something valid to snapshot. */
function writeIndex(indexPath: string, marker: string): void {
  const db = new DatabaseSync(indexPath)
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run(marker)
  db.close()
}

function readIndexMarker(indexPath: string): string {
  const db = new DatabaseSync(indexPath)
  try {
    const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string } | undefined
    return row?.v ?? ''
  } finally {
    db.close()
  }
}

/** Seed a base with a real index, a settings file, and a git clone whose origin gives provenance. */
function seedBase(kbHome: string, name: string, marker = 'INDEX'): string {
  const baseDir = path.join(kbHome, 'sessions', name)
  const clone = path.join(baseDir, 'repos', 'org-repo')
  mkdirSync(clone, { recursive: true })
  writeIndex(path.join(baseDir, '.kb-index.sqlite'), marker)
  // A non-index base file that a faithful export must carry (scan manifest, etc.).
  writeFileSync(path.join(baseDir, 'source-files-manifest.json'), `{"marker":"${marker}"}`)

  const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'Test')
  git('remote', 'add', 'origin', 'https://example.com/org/repo.git')
  writeFileSync(path.join(clone, 'file.ts'), 'export const x = 1')
  git('add', '.')
  git('commit', '-m', 'seed')
  return baseDir
}

describe('kb-server export / import', () => {
  let kbHome: string
  let bundle: string
  const prevHome = process.env.KB_HOME

  beforeEach(() => {
    kbHome = mkdtempSync(path.join(tmpdir(), 'kb-home-'))
    bundle = path.join(mkdtempSync(path.join(tmpdir(), 'kb-snapshot-')), 'out')
    process.env.KB_HOME = kbHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    rmSync(kbHome, { recursive: true, force: true })
    rmSync(path.dirname(bundle), { recursive: true, force: true })
  })

  it('exports repos + all settings by default (faithful export)', async () => {
    seedBase(kbHome, 'src')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)

    const manifest = await readSnapshotManifest(bundle)
    expect(manifest?.provenance.base).toBe('src')
    expect(manifest?.contents.includesRepos).toBe(true)
    // Provenance records the built SHA so a consumer can reconcile a re-clone.
    expect(manifest?.provenance.repos[0]).toMatchObject({
      gitUrl: 'https://example.com/org/repo.git',
      gitBranch: 'main',
      slug: 'org-repo',
    })
    expect(manifest?.provenance.repos[0]?.headSha).toMatch(/^[0-9a-f]{40}$/)
    // The index, the working tree, AND non-index settings all travel.
    expect(readIndexMarker(path.join(bundle, '.kb-index.sqlite'))).toBe('INDEX')
    expect(readFileSync(path.join(bundle, 'repos', 'org-repo', 'file.ts'), 'utf8')).toContain(
      'x = 1'
    )
    expect(readFileSync(path.join(bundle, 'source-files-manifest.json'), 'utf8')).toContain('INDEX')
  })

  it('--no-repos produces a small serve-only snapshot (index + settings, no trees)', async () => {
    seedBase(kbHome, 'src')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle, '--no-repos'], logger, kbHome)

    const manifest = await readSnapshotManifest(bundle)
    expect(manifest?.contents.includesRepos).toBe(false)
    // Working trees dropped, but provenance (incl. built SHA) still travels for re-clone.
    expect(() => readFileSync(path.join(bundle, 'repos', 'org-repo', 'file.ts'))).toThrow()
    expect(manifest?.provenance.repos[0]?.headSha).toMatch(/^[0-9a-f]{40}$/)
    // Non-index settings still travel even in a serve-only snapshot.
    expect(readFileSync(path.join(bundle, 'source-files-manifest.json'), 'utf8')).toContain('INDEX')
  })

  it('round-trips export → import into a fresh base', async () => {
    seedBase(kbHome, 'src', 'ROUNDTRIP')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)
    await runImportCommand(['--from', bundle, '--base', 'dst'], logger, kbHome)

    const dstIndex = path.join(kbHome, 'sessions', 'dst', '.kb-index.sqlite')
    expect(readIndexMarker(dstIndex)).toBe('ROUNDTRIP')
    // Provenance travels with the restored base.
    const restored = await readSnapshotManifest(path.join(kbHome, 'sessions', 'dst'))
    expect(restored?.provenance.base).toBe('src')
  })

  it('rejects export when the base has no index', async () => {
    mkdirSync(path.join(kbHome, 'sessions', 'empty'), { recursive: true })
    const { logger } = capturingLogger()
    await expect(
      runExportCommand(['--base', 'empty', '--out', bundle], logger, kbHome)
    ).rejects.toThrow(/nothing to export/)
  })

  it('refuses a non-empty --out without --force, then overwrites with --force', async () => {
    seedBase(kbHome, 'src')
    const { logger } = capturingLogger()
    mkdirSync(bundle, { recursive: true })
    writeFileSync(path.join(bundle, 'stale.txt'), 'old')
    await expect(
      runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)
    ).rejects.toThrow(/not empty/)
    await runExportCommand(['--base', 'src', '--out', bundle, '--force'], logger, kbHome)
    expect(() => readFileSync(path.join(bundle, 'stale.txt'))).toThrow()
    expect(await readSnapshotManifest(bundle)).not.toBeNull()
  })

  it('fails the integrity check when the snapshot index is tampered with', async () => {
    seedBase(kbHome, 'src')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)
    writeFileSync(path.join(bundle, '.kb-index.sqlite'), 'TAMPERED')
    await expect(
      runImportCommand(['--from', bundle, '--base', 'dst'], logger, kbHome)
    ).rejects.toThrow(/Integrity check failed/)
    // --no-verify bypasses the check.
    await runImportCommand(['--from', bundle, '--base', 'dst', '--no-verify'], logger, kbHome)
    expect(readFileSync(path.join(kbHome, 'sessions', 'dst', '.kb-index.sqlite'), 'utf8')).toBe(
      'TAMPERED'
    )
  })

  it('refuses to import over an existing index without --force', async () => {
    seedBase(kbHome, 'src')
    seedBase(kbHome, 'dst')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)
    await expect(
      runImportCommand(['--from', bundle, '--base', 'dst'], logger, kbHome)
    ).rejects.toThrow(/already has an index/)
    await runImportCommand(['--from', bundle, '--base', 'dst', '--force'], logger, kbHome)
  }, 20_000)

  it('rejects a source directory that is not a kb snapshot', async () => {
    const { logger } = capturingLogger()
    mkdirSync(bundle, { recursive: true })
    await expect(
      runImportCommand(['--from', bundle, '--base', 'dst'], logger, kbHome)
    ).rejects.toThrow(/not a kb snapshot/)
  })
})

describe('adoptSnapshot (start --from mechanics)', () => {
  let kbHome: string
  let bundle: string
  const prevHome = process.env.KB_HOME

  beforeEach(() => {
    kbHome = mkdtempSync(path.join(tmpdir(), 'kb-home-'))
    bundle = path.join(mkdtempSync(path.join(tmpdir(), 'kb-snapshot-')), 'out')
    process.env.KB_HOME = kbHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    rmSync(kbHome, { recursive: true, force: true })
    rmSync(path.dirname(bundle), { recursive: true, force: true })
  })

  // Export + adopt touches sqlite + tree copy; under full-suite load 5s is tight.
  it('restores a local snapshot into an empty base directory', { timeout: 30_000 }, async () => {
    seedBase(kbHome, 'src', 'ADOPTED')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)

    const targetBase = path.join(kbHome, 'sessions', 'serve')
    mkdirSync(targetBase, { recursive: true })
    const manifest = await adoptSnapshot({
      from: bundle,
      baseDir: targetBase,
      force: false,
      verify: true,
    })

    expect(manifest.provenance.base).toBe('src')
    expect(readIndexMarker(path.join(targetBase, '.kb-index.sqlite'))).toBe('ADOPTED')
    // The manifest, settings, and working tree all travel into the served base.
    expect(existsSync(path.join(targetBase, 'kb-snapshot.json'))).toBe(true)
    expect(readFileSync(path.join(targetBase, 'source-files-manifest.json'), 'utf8')).toContain(
      'ADOPTED'
    )
    expect(existsSync(path.join(targetBase, 'repos', 'org-repo', 'file.ts'))).toBe(true)
  })

  it('refuses to clobber an existing index unless forced', async () => {
    seedBase(kbHome, 'src')
    seedBase(kbHome, 'serve')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)

    const targetBase = path.join(kbHome, 'sessions', 'serve')
    await expect(
      adoptSnapshot({ from: bundle, baseDir: targetBase, force: false, verify: true })
    ).rejects.toThrow(/already has an index/)
    await adoptSnapshot({ from: bundle, baseDir: targetBase, force: true, verify: true })
  })

  it('verifies the digest before restoring', async () => {
    seedBase(kbHome, 'src')
    const { logger } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], logger, kbHome)
    writeFileSync(path.join(bundle, '.kb-index.sqlite'), 'CORRUPT')

    const targetBase = path.join(kbHome, 'sessions', 'serve')
    mkdirSync(targetBase, { recursive: true })
    await expect(
      adoptSnapshot({ from: bundle, baseDir: targetBase, force: false, verify: true })
    ).rejects.toThrow(/Integrity check failed/)
  })

  it('rejects a directory with no manifest', async () => {
    const targetBase = path.join(kbHome, 'sessions', 'serve')
    mkdirSync(targetBase, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    await expect(
      adoptSnapshot({ from: bundle, baseDir: targetBase, force: false, verify: true })
    ).rejects.toThrow(/not a kb snapshot/)
  })
})
