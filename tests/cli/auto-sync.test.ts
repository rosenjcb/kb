import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeBaseMeta, type GitBaseMeta } from '../../src/cli/base-meta'
import { maybeAutoSync } from '../../src/cli/auto-sync'

vi.mock('../../src/cli/git-sync', () => ({
  pullRepo: vi.fn(),
  getHeadSha: vi.fn(),
}))

vi.mock('../../src/cli/init-cli', () => ({
  runKbInit: vi.fn(),
}))

import { pullRepo, getHeadSha } from '../../src/cli/git-sync'
import { runKbInit } from '../../src/cli/init-cli'

const mockPullRepo = vi.mocked(pullRepo)
const mockGetHeadSha = vi.mocked(getHeadSha)
const mockRunKbInit = vi.mocked(runKbInit)

let baseDir: string

const staleMeta = (overrides: Partial<GitBaseMeta> = {}): GitBaseMeta => ({
  gitUrl: 'https://github.com/org/repo',
  gitBranch: 'main',
  lastSyncedSha: 'oldshaoldshaoldshaoldshaoldshaoldsha',
  lastSyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
  ...overrides,
})

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-auto-sync-test-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('auto-sync', () => {
  it('Given no meta.json, then no-ops', async () => {
    await maybeAutoSync(baseDir)
    expect(mockPullRepo).not.toHaveBeenCalled()
    expect(mockRunKbInit).not.toHaveBeenCalled()
  })

  it('Given a fresh base (synced within stale window), then skips pull', async () => {
    await writeBaseMeta(baseDir, staleMeta({
      lastSyncedAt: new Date().toISOString(), // just synced
    }))

    await maybeAutoSync(baseDir)
    expect(mockPullRepo).not.toHaveBeenCalled()
  })

  it('Given a stale base with no new commits, then updates lastSyncedAt without rescanning', async () => {
    const meta = staleMeta()
    await writeBaseMeta(baseDir, meta)
    mockPullRepo.mockResolvedValue(false) // no new commits
    mockGetHeadSha.mockResolvedValue(meta.lastSyncedSha)

    await maybeAutoSync(baseDir)

    expect(mockPullRepo).toHaveBeenCalledOnce()
    expect(mockRunKbInit).not.toHaveBeenCalled()

    const { readBaseMeta } = await import('../../src/cli/base-meta')
    const updated = await readBaseMeta(baseDir)
    expect(updated?.lastSyncedSha).toBe(meta.lastSyncedSha) // sha unchanged
    expect(updated?.lastSyncedAt).not.toBe(meta.lastSyncedAt) // timestamp refreshed
  })

  it('Given a stale base with new commits, then pulls and rescans', async () => {
    const meta = staleMeta()
    await writeBaseMeta(baseDir, meta)
    const newSha = 'newshanewshanewshanewshanewshanewsha'
    mockPullRepo.mockResolvedValue(true) // new commits
    mockGetHeadSha.mockResolvedValue(newSha)
    mockRunKbInit.mockResolvedValue({ status: 'accepted', base: path.basename(baseDir), completedCycles: [] })

    const progress: string[] = []
    await maybeAutoSync(baseDir, { onProgress: l => progress.push(l) })

    expect(mockRunKbInit).toHaveBeenCalledOnce()
    expect(mockRunKbInit).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: path.join(baseDir, 'repo'), rescan: true, nonInteractive: true })
    )

    const { readBaseMeta } = await import('../../src/cli/base-meta')
    const updated = await readBaseMeta(baseDir)
    expect(updated?.lastSyncedSha).toBe(newSha)
    expect(progress.some(l => l.includes(newSha.slice(0, 8)))).toBe(true)
  })

  it('Given a git pull failure, then logs warning and does not rescan', async () => {
    await writeBaseMeta(baseDir, staleMeta())
    mockPullRepo.mockRejectedValue(new Error('network error'))

    const progress: string[] = []
    await maybeAutoSync(baseDir, { onProgress: l => progress.push(l) })

    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(progress.some(l => l.includes('network error'))).toBe(true)
  })

  it('Given staleLimitMs: 0, then always pulls even for a freshly-synced base', async () => {
    await writeBaseMeta(baseDir, staleMeta({
      lastSyncedAt: new Date().toISOString(),
    }))
    mockPullRepo.mockResolvedValue(false)
    mockGetHeadSha.mockResolvedValue('anysha')

    await maybeAutoSync(baseDir, { staleLimitMs: 0 })
    expect(mockPullRepo).toHaveBeenCalledOnce()
  })

  it('Given staleLimitMs: 0 and a git pull failure, then warns and does not rescan', async () => {
    await writeBaseMeta(baseDir, staleMeta({
      lastSyncedAt: new Date().toISOString(),
    }))
    mockPullRepo.mockRejectedValue(new Error('network error'))

    const progress: string[] = []
    await maybeAutoSync(baseDir, { staleLimitMs: 0, onProgress: l => progress.push(l) })

    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(progress.some(l => l.includes('network error'))).toBe(true)
  })

  it('Given a custom staleLimitMs, then respects it', async () => {
    await writeBaseMeta(baseDir, staleMeta({
      lastSyncedAt: new Date(Date.now() - 10 * 1000).toISOString(), // 10 seconds ago
    }))

    // With default (30 min) threshold → fresh → no pull
    await maybeAutoSync(baseDir)
    expect(mockPullRepo).not.toHaveBeenCalled()

    // With 5-second threshold → stale → pull
    mockPullRepo.mockResolvedValue(false)
    mockGetHeadSha.mockResolvedValue('anysha')
    await maybeAutoSync(baseDir, { staleLimitMs: 5000 })
    expect(mockPullRepo).toHaveBeenCalledOnce()
  })
})
