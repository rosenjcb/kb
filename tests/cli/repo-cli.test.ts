import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/git-sync.js', () => ({
  cloneRepo: vi.fn(async () => {}),
  getCurrentBranch: vi.fn(async () => 'main'),
  getHeadSha: vi.fn(async () => 'headsha000'),
}))
vi.mock('@kb/core/ops/init-cli.js', () => ({
  runKbInit: vi.fn(async () => ({ status: 'accepted', base: 'demo', completedCycles: [] })),
  // repo-cli imports parseGitTarget too — provide the real-ish behavior.
  parseGitTarget: (raw: string, def?: string) => {
    const i = raw.lastIndexOf('#')
    return i > 0 ? { url: raw.slice(0, i), branch: raw.slice(i + 1) || def } : { url: raw, branch: def }
  },
}))

import { writeBaseMeta, readBaseMeta } from '@kb/core/storage/base-meta.js'
import { runIgnoreCommand, runRepoCommand } from '@kb/core/cli/repo-cli.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

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
  it('[TC-422] repo list reports an empty base, then the added repo', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    const empty = await runRepoCommand(['list', '--base', BASE])
    expect(empty.output).toContain('no git repos')

    await runRepoCommand(['add', 'https://github.com/org/svc', '--base', BASE])
    const listed = await runRepoCommand(['list', '--base', BASE])
    expect(listed.output).toContain('org-svc')
  })

  it('[TC-423] a bare repo command (no verb) lists', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    const empty = await runRepoCommand(['--base', BASE])
    expect(empty.output).toContain('no git repos')
  })

  it('[TC-424] rejects an unknown repo verb', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    await expect(runRepoCommand(['frobnicate', '--base', BASE])).rejects.toThrow(/Unknown repo command/)
  })

  it('[TC-425] repo add clones, indexes, and appends to meta.json', async () => {
    await writeBaseMeta(baseDir, { repos: [] })
    const res = await runRepoCommand(['add', 'https://github.com/org/svc#develop', '--base', BASE])
    expect(res.output).toContain('Added repo "org-svc"')

    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos).toHaveLength(1)
    expect(meta?.repos[0]).toMatchObject({ slug: 'org-svc', gitBranch: 'develop', dir: path.join('repos', 'org-svc') })
  })

  it('[TC-426] repo add rejects a duplicate slug', async () => {
    await writeBaseMeta(baseDir, {
      repos: [{ gitUrl: 'https://github.com/org/svc', gitBranch: 'main', slug: 'org-svc', dir: 'repos/org-svc', lastSyncedSha: 's', lastSyncedAt: 't' }],
    })
    await expect(runRepoCommand(['add', 'https://github.com/org/svc', '--base', BASE])).rejects.toThrow(
      /already tracked/
    )
  })

  it('[TC-427] repo remove purges the repo facts and drops it from meta', async () => {
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

    const res = await runRepoCommand(['remove', 'org-b', '--base', BASE])
    expect(res.output).toContain('Removed repo "org-b"')

    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos.map(r => r.slug)).toEqual(['org-a'])
    const after = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const remaining = after.listFactsForQuery(9999).filter(f => f.git_repo === 'org-b' && !f.tombstoned_at)
    after.close()
    expect(remaining).toHaveLength(0)
  })

  it('[TC-428] repo remove refuses to remove the last repo', async () => {
    await writeBaseMeta(baseDir, {
      repos: [{ gitUrl: 'https://github.com/org/a', gitBranch: 'main', slug: 'org-a', dir: 'repos/org-a', lastSyncedSha: 's', lastSyncedAt: 't' }],
    })
    await expect(runRepoCommand(['remove', 'org-a', '--base', BASE])).rejects.toThrow(/last repo/)
  })

  describe('ignore', () => {
    it('[TC-429] lists, sets, adds, removes, and clears patterns', async () => {
      await writeBaseMeta(baseDir, { repos: [] })

      const empty = await runIgnoreCommand(['list', '--base', BASE])
      expect(empty.output).toContain('no ignore patterns')

      // set replaces the whole list; comma-separated within one arg.
      await runIgnoreCommand(['set', 'tests/, vendor', '--base', BASE])
      expect((await readBaseMeta(baseDir))?.ignore).toEqual(['tests/', 'vendor'])

      // add appends + de-dupes.
      await runIgnoreCommand(['add', '**/*.spec.ts', 'vendor', '--base', BASE])
      expect((await readBaseMeta(baseDir))?.ignore).toEqual(['tests/', 'vendor', '**/*.spec.ts'])

      // bare ignore (no verb) lists.
      const listed = await runIgnoreCommand(['--base', BASE])
      expect(listed.output).toContain('tests/')
      expect(listed.output).toContain('**/*.spec.ts')

      // remove drops the named pattern.
      await runIgnoreCommand(['remove', 'vendor', '--base', BASE])
      expect((await readBaseMeta(baseDir))?.ignore).toEqual(['tests/', '**/*.spec.ts'])

      // clear empties (and drops the field).
      const cleared = await runIgnoreCommand(['clear', '--base', BASE])
      expect(cleared.output).toContain('Cleared')
      expect((await readBaseMeta(baseDir))?.ignore).toBeUndefined()
    })

    it('[TC-430] rejects an unknown verb', async () => {
      await writeBaseMeta(baseDir, { repos: [] })
      await expect(runIgnoreCommand(['frobnicate', '--base', BASE])).rejects.toThrow(
        /Unknown ignore command/
      )
    })

    it('[TC-431] requires a pattern for add/remove/set', async () => {
      await writeBaseMeta(baseDir, { repos: [] })
      await expect(runIgnoreCommand(['add', '--base', BASE])).rejects.toThrow(
        /requires at least one pattern/
      )
    })

    it('[TC-432] preserves repos when editing ignore patterns', async () => {
      await writeBaseMeta(baseDir, {
        repos: [{ gitUrl: 'https://github.com/org/a', gitBranch: 'main', slug: 'org-a', dir: 'repos/org-a', lastSyncedSha: 's', lastSyncedAt: 't' }],
      })
      await runIgnoreCommand(['add', 'tests/', '--base', BASE])
      const meta = await readBaseMeta(baseDir)
      expect(meta?.repos.map(r => r.slug)).toEqual(['org-a'])
      expect(meta?.ignore).toEqual(['tests/'])
    })
  })
})
