import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/storage/base-selection.js', () => ({
  ensureOperationalBaseDir: vi.fn(async () => '/tmp/demo'),
  readOptionalCliValue: vi.fn(() => undefined),
  resolveEffectiveBaseDir: vi.fn(async () => ({ baseDir: '/tmp/demo', baseName: 'demo' })),
}))

vi.mock('@kb/server/server-bootstrap.js', () => ({
  resolveBootstrapPlan: vi.fn(async () => ({
    base: 'demo',
    source: 'env',
    gitTargets: [{ url: 'https://github.com/fintary/fintary', branch: undefined }],
    ignore: [],
  })),
  resolveBootstrapPolicy: vi.fn(() => 'auto'),
  resolveSnapshotSource: vi.fn(() => undefined),
}))

vi.mock('@kb/core/ops/init-cli.js', () => ({
  runKbInit: vi.fn(async (options: { progressSink?: (line: string) => void }) => {
    options.progressSink?.(
      '[init] @ fintary-fintary │ [====--------------------] 1/6 code-index ts/js 1/10 changed, 0 unchanged | 27 symbols, 0 edges'
    )
    return { status: 'accepted', base: 'demo', completedCycles: [] }
  }),
}))

vi.mock('@kb/core/storage/base-repos.js', () => ({
  discoverBaseRepos: vi.fn(async () => []),
}))

vi.mock('@kb/core/storage/repo-slug.js', () => ({
  repoSlugFromGitUrl: vi.fn((url: string) => url.split('/').slice(-2).join('-')),
}))

vi.mock('@kb/core/tools/graph-query-expansion.js', () => ({
  kbIndexDbPath: vi.fn(() => '/tmp/demo/.kb-index.sqlite'),
}))

vi.mock('@kb/core/service/kb-service.js', () => ({
  createKbService: vi.fn((options: { bootstrapState: { indexing: boolean } }) => ({
    health: () => ({
      ok: true,
      base: 'demo',
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

vi.mock('@kb/core/config/kb-config.js', () => ({
  getKbConfigDir: vi.fn(() => '/tmp/kb-config'),
  ensureDefaultConfig: vi.fn(async () => ({})),
}))

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

import { ensureDefaultConfig } from '@kb/core/config/kb-config.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'
import { createHttpServer } from '@kb/server/http-server.js'
import { startReindexScheduler } from '@kb/server/reindex-scheduler.js'
import { resolveBootstrapPolicy } from '@kb/server/server-bootstrap.js'
import { runServerCommand, runServerMain } from '@kb/server/server-cli.js'

describe('runServerMain version', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('[TC-49] prints version for --version and does not start the daemon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runServerMain(['--version'])

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^kb-server v\d+\.\d+\.\d+/))
    expect(ensureDefaultConfig).not.toHaveBeenCalled()
    expect(createHttpServer).not.toHaveBeenCalled()

    log.mockRestore()
  })
})

describe('runServerCommand bootstrap progress', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('[TC-47] forwards background init progress lines into server logging', async () => {
    const out = {
      log: vi.fn(),
      error: vi.fn(),
    }

    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(runKbInit).toHaveBeenCalledWith(
        expect.objectContaining({
          progressSink: expect.any(Function),
        })
      )
    })

    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(
        '[init] @ fintary-fintary │ [====--------------------] 1/6 code-index ts/js 1/10 changed, 0 unchanged | 27 symbols, 0 edges'
      )
    })

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })

  it('[TC-48] starts the reindex scheduler only after bootstrap init completes', async () => {
    let resolveInit!: () => void
    vi.mocked(runKbInit).mockImplementationOnce(
      async (options: { progressSink?: (line: string) => void }) =>
        await new Promise(resolve => {
          resolveInit = () => {
            options.progressSink?.(
              '[init] @ fintary-fintary │ [====--------------------] 1/6 code-index ts/js 10/10 changed, 0 unchanged | 270 symbols, 9 edges'
            )
            resolve({ status: 'accepted', base: 'demo', completedCycles: [] })
          }
        })
    )

    const out = {
      log: vi.fn(),
      error: vi.fn(),
    }

    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(runKbInit).toHaveBeenCalledOnce()
    })
    expect(startReindexScheduler).not.toHaveBeenCalled()

    resolveInit()

    await vi.waitFor(() => {
      expect(startReindexScheduler).toHaveBeenCalledOnce()
    })

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })

  it('under snapshot-only policy with no index, refuses to build and surfaces the missing state', async () => {
    vi.mocked(resolveBootstrapPolicy).mockReturnValueOnce('snapshot-only')
    const out = {
      log: vi.fn(),
      error: vi.fn(),
    }

    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('no snapshot available'))
    })
    expect(runKbInit).not.toHaveBeenCalled()

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })
})
