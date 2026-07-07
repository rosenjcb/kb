import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/git-sync.js', () => ({
  getRemoteUrl: vi.fn(async (dir: string) => `https://github.com/org/${path.basename(dir)}`),
  getCurrentBranch: vi.fn(async () => 'main'),
}))

import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-base-repos-test-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('discoverBaseRepos', () => {
  it('[TC-28] returns [] when the repos/ dir is absent', async () => {
    expect(await discoverBaseRepos(baseDir)).toEqual([])
  })

  it('[TC-29] lists each git clone under repos/, deriving slug + dir from the layout', async () => {
    await mkdir(path.join(baseDir, 'repos', 'org-repo', '.git'), { recursive: true })
    await mkdir(path.join(baseDir, 'repos', 'org-web', '.git'), { recursive: true })

    const repos = await discoverBaseRepos(baseDir)
    expect(repos).toHaveLength(2)
    expect(repos).toEqual(
      expect.arrayContaining([
        {
          gitUrl: 'https://github.com/org/org-repo',
          gitBranch: 'main',
          slug: 'org-repo',
          dir: path.join('repos', 'org-repo'),
        },
        {
          gitUrl: 'https://github.com/org/org-web',
          gitBranch: 'main',
          slug: 'org-web',
          dir: path.join('repos', 'org-web'),
        },
      ])
    )
  })

  it('[TC-30] skips non-git directories under repos/', async () => {
    await mkdir(path.join(baseDir, 'repos', 'not-a-clone'), { recursive: true })
    expect(await discoverBaseRepos(baseDir)).toEqual([])
  })
})
