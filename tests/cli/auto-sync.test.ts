import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type GitBaseMeta, type GitRepoMeta, readBaseMeta, writeBaseMeta } from '../../src/cli/base-meta'
import { maybeAutoSync } from '../../src/cli/auto-sync'

vi.mock('../../src/cli/git-sync', () => ({
  pullRepo: vi.fn(),
  getHeadSha: vi.fn(),
}))

vi.mock('../../src/cli/init-cli', () => ({
  runKbInit: vi.fn(),
}))

import { getHeadSha, pullRepo } from '../../src/cli/git-sync'
import { runKbInit } from '../../src/cli/init-cli'

const mockPullRepo = vi.mocked(pullRepo)
const mockGetHeadSha = vi.mocked(getHeadSha)
const mockRunKbInit = vi.mocked(runKbInit)

let baseDir: string

function repo(overrides: Partial<GitRepoMeta> = {}): GitRepoMeta {
  return {
    gitUrl: 'https://github.com/org/repo',
    gitBranch: 'main',
    slug: 'org-repo',
    dir: path.join('repos', 'org-repo'),
    lastSyncedSha: 'oldshaoldshaoldshaoldshaoldshaoldsha',
    lastSyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    ...overrides,
  }
}

const staleMeta = (overrides: Partial<GitRepoMeta> = {}): GitBaseMeta => ({ repos: [repo(overrides)] })

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-auto-sync-test-'))
  vi.clearAllMocks()
  mockRunKbInit.mockResolvedValue({ status: 'accepted', base: path.basename(baseDir), completedCycles: [] })
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('auto-sync', () => {
  it('[TC-1] Given no meta.json, then no-ops', async () => {
    await maybeAutoSync(baseDir)
    expect(mockPullRepo).not.toHaveBeenCalled()
    expect(mockRunKbInit).not.toHaveBeenCalled()
  })

  it('[TC-2] Given a repo synced within the stale window, then skips pull', async () => {
    await writeBaseMeta(baseDir, staleMeta({ lastSyncedAt: new Date().toISOString() }))
    await maybeAutoSync(baseDir)
    expect(mockPullRepo).not.toHaveBeenCalled()
  })

  it('[TC-3] Given a stale repo with no new commits, then refreshes lastSyncedAt without rescanning', async () => {
    const meta = staleMeta()
    await writeBaseMeta(baseDir, meta)
    mockPullRepo.mockResolvedValue(false)
    mockGetHeadSha.mockResolvedValue(meta.repos[0].lastSyncedSha)

    await maybeAutoSync(baseDir)

    expect(mockPullRepo).toHaveBeenCalledOnce()
    expect(mockRunKbInit).not.toHaveBeenCalled()
    const updated = await readBaseMeta(baseDir)
    expect(updated?.repos[0].lastSyncedSha).toBe(meta.repos[0].lastSyncedSha)
    expect(updated?.repos[0].lastSyncedAt).not.toBe(meta.repos[0].lastSyncedAt)
  })

  it('[TC-4] Given a stale repo with new commits, then pulls and re-indexes that repo by slug', async () => {
    await writeBaseMeta(baseDir, staleMeta())
    const newSha = 'newshanewshanewshanewshanewshanewsha'
    mockPullRepo.mockResolvedValue(true)
    mockGetHeadSha.mockResolvedValue(newSha)

    const progress: string[] = []
    await maybeAutoSync(baseDir, { onProgress: l => progress.push(l) })

    expect(mockRunKbInit).toHaveBeenCalledOnce()
    expect(mockRunKbInit).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(baseDir, 'repos', 'org-repo'),
        rescan: true,
        nonInteractive: true,
        gitRepo: 'org-repo',
      })
    )
    const updated = await readBaseMeta(baseDir)
    expect(updated?.repos[0].lastSyncedSha).toBe(newSha)
    expect(progress.some(l => l.includes(newSha.slice(0, 8)))).toBe(true)
  })

  it('[TC-5] Given multiple repos, then only the changed repo is re-indexed and others keep their sha', async () => {
    const a = repo({ slug: 'org-a', dir: path.join('repos', 'org-a'), gitUrl: 'https://github.com/org/a' })
    const b = repo({ slug: 'org-b', dir: path.join('repos', 'org-b'), gitUrl: 'https://github.com/org/b', lastSyncedSha: 'bsha' })
    await writeBaseMeta(baseDir, { repos: [a, b] })

    // a has new commits, b does not.
    mockPullRepo.mockImplementation(async (dir: string) => dir.endsWith(path.join('repos', 'org-a')))
    mockGetHeadSha.mockImplementation(async (dir: string) =>
      dir.endsWith(path.join('repos', 'org-a')) ? 'asha-new' : 'bsha'
    )

    await maybeAutoSync(baseDir)

    expect(mockRunKbInit).toHaveBeenCalledOnce()
    expect(mockRunKbInit).toHaveBeenCalledWith(expect.objectContaining({ gitRepo: 'org-a' }))
    const updated = await readBaseMeta(baseDir)
    expect(updated?.repos.find(r => r.slug === 'org-a')?.lastSyncedSha).toBe('asha-new')
    expect(updated?.repos.find(r => r.slug === 'org-b')?.lastSyncedSha).toBe('bsha')
  })

  it("[TC-6] Given one repo's pull fails, then the other repos still sync", async () => {
    const a = repo({ slug: 'org-a', dir: path.join('repos', 'org-a') })
    const b = repo({ slug: 'org-b', dir: path.join('repos', 'org-b') })
    await writeBaseMeta(baseDir, { repos: [a, b] })

    mockPullRepo.mockImplementation(async (dir: string) => {
      if (dir.endsWith(path.join('repos', 'org-a'))) throw new Error('network error')
      return false
    })
    mockGetHeadSha.mockResolvedValue('whatever')

    const progress: string[] = []
    await maybeAutoSync(baseDir, { onProgress: l => progress.push(l) })

    expect(mockPullRepo).toHaveBeenCalledTimes(2)
    expect(progress.some(l => l.includes('network error'))).toBe(true)
  })

  it('[TC-7] Given staleLimitMs: 0, then pulls even a freshly-synced repo', async () => {
    await writeBaseMeta(baseDir, staleMeta({ lastSyncedAt: new Date().toISOString() }))
    mockPullRepo.mockResolvedValue(false)
    mockGetHeadSha.mockResolvedValue('anysha')

    await maybeAutoSync(baseDir, { staleLimitMs: 0 })
    expect(mockPullRepo).toHaveBeenCalledOnce()
  })
})
