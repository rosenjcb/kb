import { describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/auto-sync.js', () => ({
  scanBaseRepos: vi.fn(),
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

import { scanBaseRepos } from '@kb/core/ops/auto-sync.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { createKbService } from '@kb/core/service/kb-service.js'

const mockScanBaseRepos = vi.mocked(scanBaseRepos)

describe('createKbService reindex', () => {
  it('[TC-GAGS] scans the repos discovered on the base volume', async () => {
    mockScanBaseRepos.mockResolvedValue(1)

    const service = createKbService({
      baseDir: '/tmp/demo',
      config: {} as KbConfig,
    })

    await expect(service.reindex()).resolves.toBe('Scanned 1 repo(s) for base "demo".')
    expect(mockScanBaseRepos).toHaveBeenCalledWith('/tmp/demo', expect.anything())

    // With no repos on the volume, reindex surfaces a clear "declare repos via env" error.
    mockScanBaseRepos.mockResolvedValue(0)
    const empty = createKbService({ baseDir: '/tmp/empty', config: {} as KbConfig })
    await expect(empty.reindex()).rejects.toThrow(/no indexed repos/)
  })
})
