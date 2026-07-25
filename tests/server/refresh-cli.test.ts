import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bootstrap-hydration step spawns a throwaway `kb-server start` child and
// polls its /healthz. Unit tests fake both ends (spawn + fetch) rather than
// actually re-exec the CLI — mirroring the "heavy vi.mock of collaborator
// modules" pattern used elsewhere in this suite (see server-cli.test.ts) — and
// have the fake spawn perform the on-disk side effect (clone/build) a real
// bootstrap child would have produced by the time /healthz reports ready.
// Only the refresh subcommand's own bootstrap-child spawn (command === node's
// execPath) is faked; every other spawn call (production code's internal `git`
// plumbing via git-sync.ts's `run()`, used by discoverBaseRepos/scanBaseRepos)
// passes through to the real implementation untouched.
const spawnMock = vi.fn()
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, cmdArgs: string[], opts: unknown) => {
      if (cmd === process.execPath) return spawnMock(cmd, cmdArgs, opts)
      return actual.spawn(cmd, cmdArgs, opts as never)
    },
  }
})

import { readSnapshotManifest } from '@kb/core/storage/snapshot.js'
import { runServerRefreshCommand } from '@kb/server/refresh-cli.js'
import type { ServerLogger } from '@kb/server/server-cli.js'
import { runExportCommand } from '@kb/server/snapshot-cli.js'

/** A pid guaranteed not to belong to a live process (same sentinel as daemon-cli.test.ts). */
const DEAD_PID = 2147483646

function capturingLogger(): { logger: ServerLogger; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, logger: { log: m => stdout.push(m), error: m => stderr.push(m) } }
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

/** A local bare repo usable as clone origin, so hydration/scan run offline and deterministically. */
function makeOrigin(root: string, name: string): string {
  const originDir = path.join(root, `${name}-origin.git`)
  execFileSync('git', ['init', '--bare', '-b', 'main', originDir], { stdio: 'ignore' })
  const seedClone = path.join(root, `${name}-seed`)
  execFileSync('git', ['clone', originDir, seedClone], { stdio: 'ignore' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: seedClone, stdio: 'ignore' })
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(path.join(seedClone, 'file.ts'), 'export const x = 1')
  git('add', '.')
  git('commit', '-m', 'seed')
  git('push', '-u', 'origin', 'main')
  return originDir
}

function seedBaseWithClone(kbHome: string, name: string, origin: string, marker: string): string {
  const baseDir = path.join(kbHome, 'sessions', name)
  const clone = path.join(baseDir, 'repos', 'org-repo')
  mkdirSync(path.dirname(clone), { recursive: true })
  execFileSync('git', ['clone', origin, clone], { stdio: 'ignore' })
  writeIndex(path.join(baseDir, '.kb-index.sqlite'), marker)
  writeFileSync(path.join(baseDir, 'source-files-manifest.json'), `{"marker":"${marker}"}`)
  return baseDir
}

/** Configure the spawn mock to fake a bootstrap child that settles after producing `sideEffect`. */
function fakeBootstrapChild(
  fetchMock: ReturnType<typeof vi.fn>,
  sideEffect: () => void,
  health: Record<string, unknown> = { ok: true, indexing: false }
): void {
  spawnMock.mockImplementationOnce(() => {
    sideEffect()
    return { pid: DEAD_PID }
  })
  fetchMock.mockResolvedValue({ json: async () => health })
}

describe('kb-server refresh (builder orchestration)', () => {
  let root: string
  let kbHome: string
  const prevHome = process.env.KB_HOME
  let fetchMock: ReturnType<typeof vi.fn>
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-refresh-cli-'))
    kbHome = path.join(root, 'home')
    mkdirSync(kbHome, { recursive: true })
    process.env.KB_HOME = kbHome
    spawnMock.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === DEAD_PID) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    })
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    vi.unstubAllGlobals()
    killSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('[TC-119] warm: adopts the prior snapshot, re-clones the repo, and reindexes at --out', async () => {
    const origin = makeOrigin(root, 'src')
    const srcBase = seedBaseWithClone(kbHome, 'src', origin, 'SRC')
    const bundle = path.join(root, 'snap')
    const { logger: exp } = capturingLogger()
    // Production snapshots ship --no-repos: the adopted bundle has an index but no clone.
    await runExportCommand(['--base', 'src', '--out', bundle, '--no-repos'], exp, kbHome)
    expect(srcBase).toContain('src')

    const outDir = path.join(root, 'out')
    fakeBootstrapChild(fetchMock, () => {
      seedBaseWithClone(kbHome, 'dest', origin, 'SRC')
    })

    const { logger } = capturingLogger()
    await runServerRefreshCommand(
      ['--base', 'dest', '--from', bundle, '--repos', origin, '--out', outDir, '--json'],
      logger,
      kbHome
    )

    expect(readIndexMarker(path.join(outDir, '.kb-index.sqlite'))).toBe('SRC')
    const manifest = await readSnapshotManifest(outDir)
    expect(manifest?.provenance.repos).toHaveLength(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('[TC-120][TC-124] cold: clones fresh from --repos with no --from, and --json reports ok:true', async () => {
    const origin = makeOrigin(root, 'cold-src')
    const outDir = path.join(root, 'out')
    fakeBootstrapChild(fetchMock, () => {
      seedBaseWithClone(kbHome, 'coldbase', origin, 'COLD')
    })

    const { logger, stdout } = capturingLogger()
    await runServerRefreshCommand(
      ['--base', 'coldbase', '--repos', origin, '--out', outDir, '--json'],
      logger,
      kbHome
    )

    expect(stdout).toHaveLength(1)
    const summary = JSON.parse(stdout[0] as string)
    expect(summary).toMatchObject({ ok: true, base: 'coldbase', mode: 'cold', repos: 0, out: outDir })
    expect(summary.indexDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(readIndexMarker(path.join(outDir, '.kb-index.sqlite'))).toBe('COLD')
  }, 30_000)

  it('[TC-121] cold mode with neither --from nor --repos errors instead of hanging', async () => {
    const { logger } = capturingLogger()
    await expect(
      runServerRefreshCommand(['--base', 'nobody', '--out', path.join(root, 'out')], logger, kbHome)
    ).rejects.toThrow(/requires --repos for a cold build/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('[TC-122] surfaces the child bootstrap error instead of waiting out the timeout', async () => {
    spawnMock.mockImplementationOnce(() => ({ pid: DEAD_PID }))
    fetchMock.mockResolvedValue({ json: async () => ({ bootstrapError: 'clone failed: auth' }) })

    const { logger } = capturingLogger()
    await expect(
      runServerRefreshCommand(
        ['--base', 'failing', '--repos', 'https://example.invalid/repo.git', '--out', path.join(root, 'out'), '--timeout', '60000'],
        logger,
        kbHome
      )
    ).rejects.toThrow(/bootstrap child failed.*clone failed: auth/)
  })

  it('[TC-123] returns a timeout error (not a hang) when bootstrap never reaches ok:true', async () => {
    spawnMock.mockImplementationOnce(() => ({ pid: DEAD_PID }))
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, indexing: true }) })

    const { logger } = capturingLogger()
    await expect(
      runServerRefreshCommand(
        ['--base', 'slow', '--repos', 'https://example.invalid/repo.git', '--out', path.join(root, 'out'), '--timeout', '10'],
        logger,
        kbHome
      )
    ).rejects.toThrow(/did not settle within 10ms/)
  }, 10_000)

  it('[TC-125] --json emits { ok: false } on stdout before rethrowing', async () => {
    const { logger, stdout } = capturingLogger()
    await expect(
      runServerRefreshCommand(['--base', 'nobody', '--json'], logger, kbHome)
    ).rejects.toThrow(/--out/)

    expect(stdout).toHaveLength(1)
    const summary = JSON.parse(stdout[0] as string)
    expect(summary.ok).toBe(false)
    expect(typeof summary.error).toBe('string')
  })

  it('[TC-126] rejects object-store URIs for --from/--out (cloud-agnostic guardrail)', async () => {
    const { logger } = capturingLogger()
    await expect(
      runServerRefreshCommand(
        ['--base', 'x', '--from', 'gs://bucket/snap', '--out', path.join(root, 'out')],
        logger,
        kbHome
      )
    ).rejects.toThrow(/LOCAL path only/)

    await expect(
      runServerRefreshCommand(
        ['--base', 'x', '--repos', 'https://example.invalid/repo.git', '--out', 's3://bucket/out'],
        logger,
        kbHome
      )
    ).rejects.toThrow(/LOCAL path only/)
  })

  it('[TC-127] terminates the bootstrap child (no orphan) after it settles', async () => {
    const origin = makeOrigin(root, 'kill-src')
    const outDir = path.join(root, 'out')
    fakeBootstrapChild(fetchMock, () => {
      seedBaseWithClone(kbHome, 'killbase', origin, 'K')
    })

    const { logger } = capturingLogger()
    await runServerRefreshCommand(
      ['--base', 'killbase', '--repos', origin, '--out', outDir, '--json'],
      logger,
      kbHome
    )

    expect(killSpy).toHaveBeenCalledWith(DEAD_PID, 'SIGTERM')
  }, 30_000)
})
