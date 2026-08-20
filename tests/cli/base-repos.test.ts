import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/git-sync.js', () => ({
  getRemoteUrl: vi.fn(async (dir: string) => `https://github.com/org/${path.basename(dir)}`),
  getCurrentBranch: vi.fn(async () => 'main'),
}))

import { discoverBaseRepos, resolveBaseRepoRegistry } from '@kb/core/storage/base-repos.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-base-repos-test-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('discoverBaseRepos', () => {
  it('[TC-ZORN] returns [] when the repos/ dir is absent', async () => {
    expect(await discoverBaseRepos(baseDir)).toEqual([])
  })

  it('[TC-12W4] lists each git clone under repos/, deriving slug + dir from the layout', async () => {
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

  it('[TC-ITUO] skips non-git directories under repos/', async () => {
    await mkdir(path.join(baseDir, 'repos', 'not-a-clone'), { recursive: true })
    expect(await discoverBaseRepos(baseDir)).toEqual([])
  })
})

function manifestJson(repos: Array<{ gitUrl: string; gitBranch: string; slug: string }>): string {
  return JSON.stringify({
    kind: 'kb-snapshot',
    schemaVersion: 1,
    producer: { tool: 'kb', coreVersion: '0.0.0' },
    compat: { indexSchema: 1 },
    provenance: { base: 'kb', repos },
    contents: { index: ['.kb-index.sqlite'], includesRepos: false },
    digest: { algorithm: 'sha256', index: 'deadbeef' },
  })
}

describe('resolveBaseRepoRegistry', () => {
  it('[TC-Q8XM] falls back to snapshot provenance when the base carries no clones', async () => {
    // A serve-only node hydrates from a snapshot and prunes repos/. Without this
    // fallback the registry is empty and every citation loses its blob link.
    await writeFile(
      path.join(baseDir, 'kb-snapshot.json'),
      manifestJson([
        { gitUrl: 'https://github.com/rosenjcb/kb.git', gitBranch: 'main', slug: 'rosenjcb-kb' },
      ])
    )
    expect(await resolveBaseRepoRegistry(baseDir)).toEqual([
      {
        gitUrl: 'https://github.com/rosenjcb/kb.git',
        gitBranch: 'main',
        slug: 'rosenjcb-kb',
        dir: path.join('repos', 'rosenjcb-kb'),
      },
    ])
  })

  it('[TC-Q8XM] prefers live clones over the manifest when both exist', async () => {
    await mkdir(path.join(baseDir, 'repos', 'org-repo', '.git'), { recursive: true })
    await writeFile(
      path.join(baseDir, 'kb-snapshot.json'),
      manifestJson([{ gitUrl: 'https://github.com/stale/x', gitBranch: 'old', slug: 'stale-x' }])
    )
    expect((await resolveBaseRepoRegistry(baseDir)).map(r => r.slug)).toEqual(['org-repo'])
  })
})
