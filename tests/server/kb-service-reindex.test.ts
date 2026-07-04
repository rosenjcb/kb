import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/auto-sync.js', () => ({
  maybeAutoSync: vi.fn(),
}))

vi.mock('@kb/core/storage/base-meta.js', () => ({
  readBaseMeta: vi.fn(),
}))

vi.mock('@kb/core/tools/kb-tools-registry.js', () => ({
  createKBToolsRegistry: vi.fn(() => ({
    execute: vi.fn(),
  })),
}))

vi.mock('@kb/core/config/kb-config.js', () => ({
  applyConfigToEnv: vi.fn(),
  createLLMProviderFromConfig: vi.fn(() => null),
}))

import { maybeAutoSync } from '@kb/core/ops/auto-sync.js'
import { readBaseMeta, type GitBaseMeta } from '@kb/core/storage/base-meta.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { createKbService } from '@kb/core/service/kb-service.js'

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
                it('[TC-16] uses incremental auto-sync semantics instead of a forced full scan', async () => {
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
