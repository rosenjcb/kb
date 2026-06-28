import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type GitBaseMeta,
  readBaseMeta,
  repoDirForSlug,
  repoSlugFromGitUrl,
  writeBaseMeta,
} from '../../src/cli/base-meta'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-base-meta-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const sample: GitBaseMeta = {
  repos: [
    {
      gitUrl: 'https://github.com/org/repo',
      gitBranch: 'main',
      slug: 'org-repo',
      dir: 'repos/org-repo',
      lastSyncedSha: 'abc1234defabc1234defabc1234defabc1234def',
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
    },
  ],
}

describe('base-meta', () => {
  it('[TC-28] readBaseMeta returns null when meta.json does not exist', async () => {
    expect(await readBaseMeta(tmpDir)).toBeNull()
  })

  it('[TC-29] round-trips a multi-repo meta', async () => {
    const multi: GitBaseMeta = {
      repos: [
        ...sample.repos,
        {
          gitUrl: 'git@github.com:org/web.git',
          gitBranch: 'develop',
          slug: 'org-web',
          dir: 'repos/org-web',
          lastSyncedSha: 'def5678',
          lastSyncedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }
    await writeBaseMeta(tmpDir, multi)
    expect(await readBaseMeta(tmpDir)).toEqual(multi)
  })

  it('[TC-30] normalizes a legacy single-repo meta into one repo entry keeping the repo/ clone dir', async () => {
    await writeFile(
      path.join(tmpDir, 'meta.json'),
      JSON.stringify({
        gitUrl: 'https://github.com/org/legacy',
        gitBranch: 'main',
        lastSyncedSha: 'oldsha',
        lastSyncedAt: '2026-05-01T00:00:00.000Z',
      })
    )
    const result = await readBaseMeta(tmpDir)
    expect(result?.repos).toHaveLength(1)
    expect(result?.repos[0]).toMatchObject({
      gitUrl: 'https://github.com/org/legacy',
      gitBranch: 'main',
      slug: 'org-legacy',
      dir: 'repo',
      lastSyncedSha: 'oldsha',
    })
  })

  it('[TC-31] round-trips an ignore list alongside repos', async () => {
    const withIgnore: GitBaseMeta = {
      ...sample,
      ignore: ['tests/', '**/*.spec.ts', 'vendor'],
    }
    await writeBaseMeta(tmpDir, withIgnore)
    expect(await readBaseMeta(tmpDir)).toEqual(withIgnore)
  })

  it('[TC-32] repoSlugFromGitUrl handles https, ssh, and local paths', () => {
    expect(repoSlugFromGitUrl('https://github.com/Acme/Auth-Svc.git')).toBe('acme-auth-svc')
    expect(repoSlugFromGitUrl('git@github.com:Acme/web.git')).toBe('acme-web')
    expect(repoSlugFromGitUrl('/tmp/fixtures/my-service')).toBe('fixtures-my-service')
  })

  it('[TC-33] repoDirForSlug nests clones under repos/', () => {
    expect(repoDirForSlug('org-repo')).toBe(path.join('repos', 'org-repo'))
  })
})
