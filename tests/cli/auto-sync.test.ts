import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/git-sync.js', () => ({
  pullRepo: vi.fn(),
  getHeadSha: vi.fn(),
  getRemoteUrl: vi.fn(),
  getCurrentBranch: vi.fn(),
}))

vi.mock('@kb/core/ops/init-cli.js', () => ({
  runKbInit: vi.fn(),
}))

vi.mock('@kb/core/core/embeddings.js', () => ({
  createEmbedder: vi.fn(() => ({
    modelId: 'test:fake:3',
    dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
  })),
}))

import { scanBaseRepos } from '@kb/core/ops/auto-sync.js'
import { createEmbedder } from '@kb/core/core/embeddings.js'
import { getCurrentBranch, getHeadSha, getRemoteUrl, pullRepo } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'

const mockPullRepo = vi.mocked(pullRepo)
const mockGetHeadSha = vi.mocked(getHeadSha)
const mockGetRemoteUrl = vi.mocked(getRemoteUrl)
const mockGetCurrentBranch = vi.mocked(getCurrentBranch)
const mockRunKbInit = vi.mocked(runKbInit)
const mockCreateEmbedder = vi.mocked(createEmbedder)

let baseDir: string

/** Materialize a fake clone at `repos/<slug>/.git` so `discoverBaseRepos` picks it up. */
async function addClone(slug: string): Promise<void> {
  await mkdir(path.join(baseDir, 'repos', slug, '.git'), { recursive: true })
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-auto-sync-test-'))
  vi.clearAllMocks()
  mockRunKbInit.mockResolvedValue({
    status: 'accepted',
    base: path.basename(baseDir),
    completedCycles: [],
  })
  mockGetCurrentBranch.mockResolvedValue('main')
  mockGetRemoteUrl.mockImplementation(
    async (dir: string) => `https://github.com/org/${path.basename(dir)}`
  )
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('scanBaseRepos', () => {
  it('[TC-APK3] Given no clones on the volume, then no-ops and returns 0', async () => {
    expect(await scanBaseRepos(baseDir)).toBe(0)
    expect(mockPullRepo).not.toHaveBeenCalled()
    expect(mockRunKbInit).not.toHaveBeenCalled()
  })

  it('[TC-BNCE] Given a repo with no new commits, then pulls but does not re-index', async () => {
    await addClone('org-repo')
    mockPullRepo.mockResolvedValue(false)
    mockGetHeadSha.mockResolvedValue('samesha')

    expect(await scanBaseRepos(baseDir)).toBe(1)
    expect(mockPullRepo).toHaveBeenCalledOnce()
    expect(mockRunKbInit).not.toHaveBeenCalled()
  })

  it('[TC-P865] Given a repo with new commits, then pulls and re-indexes that repo by slug', async () => {
    await addClone('org-repo')
    const newSha = 'newshanewshanewshanewshanewshanewsha'
    mockPullRepo.mockResolvedValue(true)
    mockGetHeadSha.mockResolvedValue(newSha)

    const progress: string[] = []
    await scanBaseRepos(baseDir, { onProgress: l => progress.push(l) })

    expect(mockRunKbInit).toHaveBeenCalledOnce()
    expect(mockRunKbInit).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(baseDir, 'repos', 'org-repo'),
        rescan: true,
        nonInteractive: true,
        gitRepo: 'org-repo',
      })
    )
    expect(progress.some(l => l.includes(newSha.slice(0, 8)))).toBe(true)
  })

  it('[TC-VI0W] Given multiple repos, then only the changed repo is re-indexed', async () => {
    await addClone('org-a')
    await addClone('org-b')
    mockPullRepo.mockImplementation(async (dir: string) =>
      dir.endsWith(path.join('repos', 'org-a'))
    )
    mockGetHeadSha.mockResolvedValue('sha')

    expect(await scanBaseRepos(baseDir)).toBe(2)
    expect(mockRunKbInit).toHaveBeenCalledOnce()
    expect(mockRunKbInit).toHaveBeenCalledWith(expect.objectContaining({ gitRepo: 'org-a' }))
  })

  it('[TC-9FQW] Given skipEmbeddings, then the per-repo reindex and the trailing embed pass both skip the embedder', async () => {
    await addClone('org-repo')
    mockPullRepo.mockResolvedValue(true)
    mockGetHeadSha.mockResolvedValue('newshanewshanewshanewshanewshanewsha')

    await scanBaseRepos(baseDir, { skipEmbeddings: true })

    expect(mockRunKbInit).toHaveBeenCalledWith(expect.objectContaining({ skipEmbeddings: true }))
    expect(mockCreateEmbedder).not.toHaveBeenCalled()
  })

  it("[TC-R0QY] Given one repo's pull fails, then the other repos still sync", async () => {
    await addClone('org-a')
    await addClone('org-b')
    mockPullRepo.mockImplementation(async (dir: string) => {
      if (dir.endsWith(path.join('repos', 'org-a'))) throw new Error('network error')
      return false
    })
    mockGetHeadSha.mockResolvedValue('whatever')

    const progress: string[] = []
    await scanBaseRepos(baseDir, { onProgress: l => progress.push(l) })

    expect(mockPullRepo).toHaveBeenCalledTimes(2)
    expect(progress.some(l => l.includes('network error'))).toBe(true)
  })
})
