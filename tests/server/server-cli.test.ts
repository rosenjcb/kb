import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/storage/base-selection.js', () => ({
  DEFAULT_BASE_SLUG: 'default',
  ensureBaseExists: vi.fn(async (base: string) => ({ baseDir: `/tmp/${base}`, created: false })),
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
      '[init] @ fintary-fintary │ [====--------------------] 1/3 code-index ts/js 1/10 changed, 0 unchanged | 27 symbols, 0 edges'
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

vi.mock('@kb/core/tools/kb-index-path.js', () => ({
  kbIndexDbPath: vi.fn(() => '/tmp/demo/.kb-index.sqlite'),
}))

vi.mock('@kb/core/service/kb-service.js', () => ({
  createKbService: vi.fn((options: { baseDir?: string; bootstrapState: { indexing: boolean } }) => ({
    baseDir: options.baseDir ?? '/tmp/demo',
    health: () => ({
      ok: true,
      base: 'demo',
      provider: 'gemini',
      model: 'gemini-3.5-flash',
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
  readKbConfig: vi.fn(async () => ({})),
  persistInferredLLMProvider: vi.fn(async ({ config }: { config: unknown }) => ({
    config,
    notice: 'ℹ Auto-selected LLM provider: gemini (detected GEMINI_API_KEY). Optional: export KB_LLM_PROVIDER=gemini',
  })),
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

import { persistInferredLLMProvider, readKbConfig } from '@kb/core/config/kb-config.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'
import { createHttpServer } from '@kb/server/http-server.js'
import { startReindexScheduler } from '@kb/server/reindex-scheduler.js'
import { resolveBootstrapPolicy } from '@kb/server/server-bootstrap.js'
import {
  clientScopedBaseEnvWarnings,
  runServerCommand,
  runServerMain,
} from '@kb/server/server-cli.js'

describe('runServerMain version', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('[TC-QFNG] prints version for --version and does not start the daemon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runServerMain(['--version'])

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^kb-server v\d+\.\d+\.\d+/))
    expect(readKbConfig).not.toHaveBeenCalled()
    expect(createHttpServer).not.toHaveBeenCalled()

    log.mockRestore()
  })
})

describe('runServerCommand bootstrap progress', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('[TC-YOW6] forwards background init progress lines into server logging', async () => {
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
        '[init] @ fintary-fintary │ [====--------------------] 1/3 code-index ts/js 1/10 changed, 0 unchanged | 27 symbols, 0 edges'
      )
    })

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })

  it('[TC-82TT] starts the reindex scheduler only after bootstrap init completes', async () => {
    let resolveInit!: () => void
    vi.mocked(runKbInit).mockImplementationOnce(
      async (options: { progressSink?: (line: string) => void }) =>
        await new Promise(resolve => {
          resolveInit = () => {
            options.progressSink?.(
              '[init] @ fintary-fintary │ [====--------------------] 1/3 code-index ts/js 10/10 changed, 0 unchanged | 270 symbols, 9 edges'
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

  it('prints LLM provider auto-selection and LLM line on server start', async () => {
    const out = {
      log: vi.fn(),
      error: vi.fn(),
    }

    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(persistInferredLLMProvider).toHaveBeenCalledOnce()
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('Auto-selected LLM provider: gemini'))
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('LLM: gemini (gemini-3.5-flash)'))
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('kb-server listening'))
    })

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
  })

  it('[TC-ENW1] warns when the client-scoped KB_BASE is set without KB_SERVER_BASE_NAME', async () => {
    const prevBase = process.env.KB_BASE
    const prevServerBase = process.env.KB_SERVER_BASE_NAME
    process.env.KB_BASE = 'raylib'
    delete process.env.KB_SERVER_BASE_NAME
    const out = { log: vi.fn(), error: vi.fn() }

    const serverPromise = runServerCommand([], out, {} as never)
    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('kb-server listening'))
    })

    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('KB_BASE'))
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('KB_SERVER_BASE_NAME'))

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
    if (prevServerBase === undefined) delete process.env.KB_SERVER_BASE_NAME
    else process.env.KB_SERVER_BASE_NAME = prevServerBase
  })

  it('[TC-ENW2] does not warn when KB_BASE is unset', async () => {
    const prevBase = process.env.KB_BASE
    delete process.env.KB_BASE
    const out = { log: vi.fn(), error: vi.fn() }

    const serverPromise = runServerCommand([], out, {} as never)

    await vi.waitFor(() => {
      expect(out.log).toHaveBeenCalledWith(expect.stringContaining('kb-server listening'))
    })
    expect(out.error).not.toHaveBeenCalledWith(expect.stringContaining('KB_BASE'))

    process.emit('SIGTERM', 'SIGTERM')
    await serverPromise
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
  })
})

describe('clientScopedBaseEnvWarnings', () => {
  const ENV_KEYS = ['KB_BASE', 'KB_SERVER_BASE_NAME', 'KB_GIT_REPOS', 'KB_SERVER_BASE_GIT_REPOS'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('[TC-DMW3] warns about KB_GIT_REPOS without KB_SERVER_BASE_GIT_REPOS, independently of the KB_BASE pair', () => {
    process.env.KB_GIT_REPOS = 'https://github.com/acme/repo'
    const warnings = clientScopedBaseEnvWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('KB_GIT_REPOS')
    expect(warnings[0]).toContain('KB_SERVER_BASE_GIT_REPOS')
  })

  it('[TC-DMW4] returns both warnings when both client-scoped vars are set without their server-scoped counterparts', () => {
    process.env.KB_BASE = 'raylib'
    process.env.KB_GIT_REPOS = 'https://github.com/acme/repo'
    expect(clientScopedBaseEnvWarnings()).toHaveLength(2)
  })

  it('[TC-DMW5] returns no warnings once the server-scoped counterpart is also set', () => {
    process.env.KB_BASE = 'raylib'
    process.env.KB_SERVER_BASE_NAME = 'raylib'
    process.env.KB_GIT_REPOS = 'https://github.com/acme/repo'
    process.env.KB_SERVER_BASE_GIT_REPOS = 'https://github.com/acme/repo'
    expect(clientScopedBaseEnvWarnings()).toHaveLength(0)
  })
})
