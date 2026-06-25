import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/cli/base-selection', () => ({
  ensureOperationalBaseDir: vi.fn(async () => '/tmp/demo'),
  readOptionalCliValue: vi.fn(() => undefined),
  resolveEffectiveBaseDir: vi.fn(async () => ({ baseDir: '/tmp/demo', baseName: 'demo' })),
}))

vi.mock('../../src/server/server-bootstrap', () => ({
  resolveBootstrapPlan: vi.fn(async () => ({
    base: 'demo',
    source: 'env',
    gitTargets: [{ url: 'https://github.com/fintary/fintary', branch: undefined }],
    ignore: [],
  })),
}))

vi.mock('../../src/cli/init-cli', () => ({
  runKbInit: vi.fn(async (options: { progressSink?: (line: string) => void }) => {
    options.progressSink?.(
      '[init] @ fintary-fintary │ [====--------------------] 1/6 code-index ts/js 1/10 changed, 0 unchanged | 27 symbols, 0 edges'
    )
    return { status: 'accepted', base: 'demo', completedCycles: [] }
  }),
}))

vi.mock('../../src/cli/base-meta', () => ({
  readBaseMeta: vi.fn(async () => null),
  repoSlugFromGitUrl: vi.fn((url: string) => url.split('/').slice(-2).join('-')),
}))

vi.mock('../../src/tools/graph-query-expansion', () => ({
  kbIndexDbPath: vi.fn(() => '/tmp/demo/.kb-index.sqlite'),
}))

vi.mock('../../src/server/kb-service', () => ({
  createKbService: vi.fn((options: { bootstrapState: { indexing: boolean } }) => ({
    health: () => ({ ok: true, base: 'demo', ...(options.bootstrapState.indexing ? { indexing: true } : {}) }),
    reindex: vi.fn(),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock('../../src/server/reindex-scheduler', () => ({
  parseDuration: vi.fn(() => 0),
  startReindexScheduler: vi.fn(() => ({ stop: vi.fn(), isRunning: () => false })),
}))

vi.mock('../../src/cli/kb-config', () => ({
  getKbConfigDir: vi.fn(() => '/tmp/kb-config'),
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

vi.mock('../../src/server/http-server', () => ({
  createHttpServer: vi.fn(() => fakeServer),
}))

import { runKbInit } from '../../src/cli/init-cli'
import { runServerCommand } from '../../src/server/server-cli'

describe('runServerCommand bootstrap progress', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forwards background init progress lines into server logging', async () => {
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
})
