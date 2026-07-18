import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readSnapshotManifest } from '@kb/core/storage/snapshot.js'
import { runServerScanCommand } from '@kb/server/scan-cli.js'
import type { ServerLogger } from '@kb/server/server-cli.js'
import { runExportCommand } from '@kb/server/snapshot-cli.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

function capturingLogger(): {
  logger: ServerLogger
  stdout: string[]
  stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    logger: { log: m => stdout.push(m), error: m => stderr.push(m) },
  }
}

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

/**
 * Seed a base whose repo clone tracks a LOCAL bare origin, so the scan's
 * `git fetch` + `reset --hard @{u}` succeeds offline (no network, no flakiness)
 * and brings no new commits — exercising the pull/hash-diff path deterministically.
 */
function seedBase(root: string, kbHome: string, name: string, marker = 'INDEX'): string {
  const originDir = path.join(root, `${name}-origin.git`)
  execFileSync('git', ['init', '--bare', '-b', 'main', originDir], { stdio: 'ignore' })

  const baseDir = path.join(kbHome, 'sessions', name)
  const clone = path.join(baseDir, 'repos', 'org-repo')
  mkdirSync(path.dirname(clone), { recursive: true })
  execFileSync('git', ['clone', originDir, clone], { stdio: 'ignore' })

  const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'ignore' })
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(path.join(clone, 'file.ts'), 'export const x = 1')
  git('add', '.')
  git('commit', '-m', 'seed')
  git('push', '-u', 'origin', 'main')

  writeIndex(path.join(baseDir, '.kb-index.sqlite'), marker)
  writeFileSync(path.join(baseDir, 'source-files-manifest.json'), `{"marker":"${marker}"}`)
  return baseDir
}

describe('kb-server scan (one-shot batch reindex)', () => {
  let root: string
  let kbHome: string
  const prevHome = process.env.KB_HOME

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-scan-cli-'))
    kbHome = path.join(root, 'home')
    mkdirSync(kbHome, { recursive: true })
    process.env.KB_HOME = kbHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  it('adopt(--from) → scan → export(--out) round-trips on local paths', async () => {
    // Build a snapshot from a source base, then reindex a *fresh* base from it.
    seedBase(root, kbHome, 'src', 'BATCH')
    const bundle = path.join(root, 'snap')
    const { logger: exp } = capturingLogger()
    await runExportCommand(['--base', 'src', '--out', bundle], exp, kbHome)

    const outDir = path.join(root, 'out')
    const { logger } = capturingLogger()
    await runServerScanCommand(['--base', 'batch', '--from', bundle, '--out', outDir], logger, kbHome)

    // The fresh base adopted the index, scanned, and exported a refreshed snapshot.
    const batchIndex = path.join(kbHome, 'sessions', 'batch', '.kb-index.sqlite')
    expect(readIndexMarker(batchIndex)).toBe('BATCH')
    expect(readIndexMarker(path.join(outDir, '.kb-index.sqlite'))).toBe('BATCH')
    const manifest = await readSnapshotManifest(outDir)
    expect(manifest?.provenance.base).toBe('batch')
    expect(manifest?.provenance.repos).toHaveLength(1)
  }, 30_000)

  it('scans a warm base in place with no --from / --out', async () => {
    seedBase(root, kbHome, 'warm', 'WARM')
    const { logger, stdout } = capturingLogger()
    await runServerScanCommand(['--base', 'warm'], logger, kbHome)

    // Index untouched (no new commits), and the run reports completion.
    expect(readIndexMarker(path.join(kbHome, 'sessions', 'warm', '.kb-index.sqlite'))).toBe('WARM')
    expect(stdout.join('\n')).toMatch(/Reindex complete/)
  }, 30_000)

  it('--json emits a single machine-readable summary on stdout', async () => {
    seedBase(root, kbHome, 'warm', 'JSON')
    const outDir = path.join(root, 'out')
    const { logger, stdout } = capturingLogger()
    await runServerScanCommand(['--base', 'warm', '--out', outDir, '--json'], logger, kbHome)

    // In --json mode stdout carries exactly the summary object; progress goes to stderr.
    expect(stdout).toHaveLength(1)
    const summary = JSON.parse(stdout[0] as string)
    expect(summary).toMatchObject({
      ok: true,
      base: 'warm',
      adopted: false,
      from: null,
      repos: 1,
      exported: true,
      out: outDir,
    })
    expect(summary.indexDigest).toMatch(/^[0-9a-f]{64}$/)
  }, 30_000)

  it('rejects object-store URIs for --from (cloud-agnostic guardrail)', async () => {
    const { logger } = capturingLogger()
    await expect(
      runServerScanCommand(['--base', 'batch', '--from', 'gs://bucket/snap'], logger, kbHome)
    ).rejects.toThrow(/LOCAL path only/)
  })

  it('rejects object-store URIs for --out (cloud-agnostic guardrail)', async () => {
    const { logger } = capturingLogger()
    await expect(
      runServerScanCommand(['--base', 'batch', '--out', 's3://bucket/out'], logger, kbHome)
    ).rejects.toThrow(/LOCAL path only/)
  })

  it('fails fast on non-empty --out without --force (before scan work)', async () => {
    seedBase(root, kbHome, 'warm', 'FAST')
    const outDir = path.join(root, 'stale-out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'leftover.txt'), 'stale')

    const { logger, stdout } = capturingLogger()
    await expect(
      runServerScanCommand(['--base', 'warm', '--out', outDir, '--json'], logger, kbHome)
    ).rejects.toThrow(/not empty/)

    const summary = JSON.parse(stdout[0] as string)
    expect(summary).toMatchObject({ ok: false, error: expect.stringMatching(/not empty/) })
    // Index marker unchanged — we never reached a destructive export wipe.
    expect(readIndexMarker(path.join(kbHome, 'sessions', 'warm', '.kb-index.sqlite'))).toBe('FAST')
  }, 30_000)

  it('--json emits { ok: false } on stdout before rethrowing', async () => {
    const { logger, stdout } = capturingLogger()
    await expect(
      runServerScanCommand(['--base', 'missing-base-xyz', '--json'], logger, kbHome)
    ).rejects.toThrow()

    expect(stdout).toHaveLength(1)
    const summary = JSON.parse(stdout[0] as string)
    expect(summary.ok).toBe(false)
    expect(typeof summary.error).toBe('string')
    expect(summary.error.length).toBeGreaterThan(0)
  })
})
