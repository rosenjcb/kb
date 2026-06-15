import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/cli/git-sync', () => ({
  cloneRepo: vi.fn(async () => {}),
  getHeadSha: vi.fn(async () => 'headsha000'),
}))
vi.mock('../../src/cli/init-cli', () => ({
  runKbInit: vi.fn(async () => ({ status: 'accepted', base: 'demo', completedCycles: [] })),
  // repo-cli imports parseGitTarget too — provide the real-ish behavior.
  parseGitTarget: (raw: string, def: string) => {
    const i = raw.lastIndexOf('#')
    return i > 0 ? { url: raw.slice(0, i), branch: raw.slice(i + 1) || def } : { url: raw, branch: def }
  },
}))

import { writeBaseMeta, readBaseMeta } from '../../src/cli/base-meta'
import { runRepoCommand } from '../../src/cli/repo-cli'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

let kbHome: string
let baseDir: string
const BASE = 'demo'

beforeEach(async () => {
  kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-repo-cli-home-'))
  process.env.KB_HOME = kbHome
  baseDir = path.join(kbHome, 'sessions', BASE)
  await mkdir(baseDir, { recursive: true })
  // Touch the index so the base is considered initialized.
  new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()
  vi.clearAllMocks()
})

afterEach(async () => {
  process.env.KB_HOME = undefined
  await rm(kbHome, { recursive: true, force: true })
})

describe('repo-cli', () => {
  it('list-repos reports an empty base, then the added repo', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    const empty = await runRepoCommand('list-repos', ['--base', BASE])
    expect(empty.output).toContain('no git repos')

    await runRepoCommand('add-repo', ['https://github.com/org/svc', '--base', BASE])
    const listed = await runRepoCommand('list-repos', ['--base', BASE])
    expect(listed.output).toContain('org-svc')
  })

  it('add-repo clones, indexes, and appends to meta.json', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    const res = await runRepoCommand('add-repo', ['https://github.com/org/svc#develop', '--base', BASE])
    expect(res.output).toContain('Added repo "org-svc"')

    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos).toHaveLength(1)
    expect(meta?.repos[0]).toMatchObject({ slug: 'org-svc', gitBranch: 'develop', dir: path.join('repos', 'org-svc') })
  })

  it('add-repo rejects a duplicate slug', async () => {
    await writeBaseMeta(baseDir, {
      repos: [{ gitUrl: 'https://github.com/org/svc', gitBranch: 'main', slug: 'org-svc', dir: 'repos/org-svc', lastSyncedSha: 's', lastSyncedAt: 't' }],
    })
    await expect(runRepoCommand('add-repo', ['https://github.com/org/svc', '--base', BASE])).rejects.toThrow(
      /already tracked/
    )
  })

  it('remove-repo purges the repo facts and drops it from meta', async () => {
    // Two repos so removal is allowed; seed a fact for the one we remove.
    await writeBaseMeta(baseDir, {
      repos: [
        { gitUrl: 'https://github.com/org/a', gitBranch: 'main', slug: 'org-a', dir: 'repos/org-a', lastSyncedSha: 's', lastSyncedAt: 't' },
        { gitUrl: 'https://github.com/org/b', gitBranch: 'main', slug: 'org-b', dir: 'repos/org-b', lastSyncedSha: 's', lastSyncedAt: 't' },
      ],
    })
    const seed = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    seed.upsertFact({ factText: 'b fact one', sourceKind: 'import_doc', sourceRef: 'b/x#s0', gitRepo: 'org-b' })
    seed.close()

    const res = await runRepoCommand('remove-repo', ['org-b', '--base', BASE])
    expect(res.output).toContain('Removed repo "org-b"')

    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos.map(r => r.slug)).toEqual(['org-a'])
    const after = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const remaining = after.listFactsForQuery(9999).filter(f => f.git_repo === 'org-b' && !f.tombstoned_at)
    after.close()
    expect(remaining).toHaveLength(0)
  })

  it('remove-repo refuses to remove the last repo', async () => {
    await writeBaseMeta(baseDir, {
      repos: [{ gitUrl: 'https://github.com/org/a', gitBranch: 'main', slug: 'org-a', dir: 'repos/org-a', lastSyncedSha: 's', lastSyncedAt: 't' }],
    })
    await expect(runRepoCommand('remove-repo', ['org-a', '--base', BASE])).rejects.toThrow(/last repo/)
  })
})
