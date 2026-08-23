import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/init-cli.js', () => ({
  runKbInit: vi.fn(async () => ({ status: 'accepted', base: 'default', completedCycles: [] })),
}))

vi.mock('@kb/core/ops/scan-command.js', () => ({
  runScanCommand: vi.fn(async () => {}),
}))

vi.mock('@kb/core/storage/base-repos.js', () => ({
  discoverBaseRepos: vi.fn(async () => []),
}))

vi.mock('@kb/core/service/kb-service.js', () => ({
  createKbService: vi.fn((options: { baseDir: string; bootstrapState: { indexing: boolean } }) => ({
    baseDir: options.baseDir,
    health: () => ({
      ok: true,
      base: path.basename(options.baseDir),
      provider: undefined,
      model: undefined,
      ...(options.bootstrapState.indexing ? { indexing: true } : {}),
    }),
    reindex: vi.fn(),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock('@kb/server/reindex-scheduler.js', () => ({
  parseDuration: vi.fn(() => 0),
  startReindexScheduler: vi.fn(() => ({ stop: vi.fn(), isRunning: () => false })),
}))

vi.mock('@kb/core/config/kb-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@kb/core/config/kb-config.js')>()
  return {
    ...actual,
    readKbConfig: vi.fn(async () => ({})),
    persistInferredLLMProvider: vi.fn(async ({ config }: { config: unknown }) => ({
      config,
      notice: undefined,
    })),
  }
})

class FakeServer extends EventEmitter {
  listen(_port: number, cb: () => void): void {
    cb()
  }
  close(cb: () => void): void {
    cb()
  }
}
const fakeServer = new FakeServer()
vi.mock('@kb/server/http-server.js', () => ({
  createHttpServer: vi.fn(() => fakeServer),
}))

import { kbIndexDbPath } from '@kb/core/tools/kb-index-path.js'
import { resolveServerBaseDir, runServerCommand } from '@kb/server/server-cli.js'

/**
 * Regression coverage for a bug the boot-chain rewrite introduced: `resolveServerBaseDir`
 * used to eagerly materialize an empty index (via `ensureBaseExists`), which made every
 * fresh volume look "already built" to the two checks that run right after it —
 * `adoptLocalSnapshotIfProvided`'s existsSync gate and the `--bootstrap-policy
 * snapshot-only` refusal. The fix defers index materialization until `planBootstrapTask`
 * has confirmed there is genuinely nothing else to do. These tests use real fs (no mock
 * of `base-selection.js`/`kb-index-path.js`) so they actually exercise that ordering,
 * unlike `server-cli.test.ts`, which mocks `ensureBaseExists` and never touches disk.
 */
describe('server boot: index materialization is deferred, not eager', () => {
  let kbHomeDir: string
  let prevHome: string | undefined
  let prevPort: string | undefined

  beforeEach(async () => {
    prevHome = process.env.KB_HOME
    prevPort = process.env.PORT
    kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-server-boot-'))
    process.env.KB_HOME = kbHomeDir
    process.env.PORT = '0'
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    if (prevPort === undefined) delete process.env.PORT
    else process.env.PORT = prevPort
    await rm(kbHomeDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('resolveServerBaseDir ensures the directory but does not create an index', async () => {
    const resolved = await resolveServerBaseDir({ gitTargets: [], source: 'none' })
    expect(existsSync(resolved.baseDir)).toBe(true)
    expect(existsSync(kbIndexDbPath(resolved.baseDir))).toBe(false)
  })

  it('[TC-SNP1] a fresh volume under --bootstrap-policy snapshot-only refuses to start instead of silently serving an empty base', async () => {
    const out = { log: vi.fn(), error: vi.fn() }
    const serverPromise = runServerCommand(['--bootstrap-policy', 'snapshot-only'], out, {} as never)

    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('no snapshot available'))
    })

    // The refusal must fire before any index gets materialized — proves the gate
    // isn't being defeated by an eagerly-created empty placeholder.
    const dbPath = kbIndexDbPath(path.join(kbHomeDir, 'sessions', 'default'))
    expect(existsSync(dbPath)).toBe(false)

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })

  it('[TC-HEL2] an empty default base under the normal (auto) policy still self-heals into a real, migrated index by the time boot completes', async () => {
    const out = { log: vi.fn(), error: vi.fn() }
    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('kb-server listening'))
    })

    const dbPath = kbIndexDbPath(path.join(kbHomeDir, 'sessions', 'default'))
    await vi.waitFor(() => {
      expect(existsSync(dbPath)).toBe(true)
    })

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })
})
