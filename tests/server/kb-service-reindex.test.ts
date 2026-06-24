import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/cli/auto-sync', () => ({
  maybeAutoSync: vi.fn(),
}))

vi.mock('../../src/cli/base-meta', () => ({
  readBaseMeta: vi.fn(),
}))

vi.mock('../../src/tools/kb-tools-registry', () => ({
  createKBToolsRegistry: vi.fn(() => ({
    execute: vi.fn(),
  })),
}))

vi.mock('../../src/cli/kb-config', () => ({
  applyConfigToEnv: vi.fn(),
  createLLMProviderFromConfig: vi.fn(() => null),
}))

import { maybeAutoSync } from '../../src/cli/auto-sync'
import { readBaseMeta, type GitBaseMeta } from '../../src/cli/base-meta'
import type { KbConfig } from '../../src/cli/kb-config'
import { createKbService } from '../../src/server/kb-service'

const mockMaybeAutoSync = vi.mocked(maybeAutoSync)
const mockReadBaseMeta = vi.mocked(readBaseMeta)

function meta(): GitBaseMeta {
  return {
    repos: [
      {
        gitUrl: 'https://github.com/fintary/fintary',
        gitBranch: 'main',
        slug: 'fintary-fintary',
        dir: path.join('repos', 'fintary-fintary'),
        lastSyncedSha: 'abc123',
        lastSyncedAt: new Date(0).toISOString(),
      },
    ],
  }
}

describe('createKbService reindex', () => {
  it('uses incremental auto-sync semantics instead of a forced full scan', async () => {
    mockReadBaseMeta.mockResolvedValue(meta())
    mockMaybeAutoSync.mockResolvedValue(undefined)

    const service = createKbService({
      baseDir: '/tmp/demo',
      config: {} as KbConfig,
    })

    await expect(service.reindex()).resolves.toBe('Scanned 1 repo(s) for base "demo".')
    expect(mockMaybeAutoSync).toHaveBeenCalledWith('/tmp/demo', { staleLimitMs: 0 })
  })
})
