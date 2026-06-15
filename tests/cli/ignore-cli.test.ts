import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type GitRepoMeta, readBaseMeta, writeBaseMeta } from '../../src/cli/base-meta'
import { IgnoreCommandError, runIgnoreCommand } from '../../src/cli/ignore-cli'

const BASE = 'testbase'
let tempHome: string
let prevHome: string | undefined

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'kb-ignore-home-'))
  prevHome = process.env.KB_HOME
  process.env.KB_HOME = tempHome
  await mkdir(baseDir(), { recursive: true })
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.KB_HOME
  else process.env.KB_HOME = prevHome
  await rm(tempHome, { recursive: true, force: true })
})

function baseDir(): string {
  return path.join(tempHome, 'sessions', BASE)
}

async function ignore(): Promise<string[]> {
  return (await readBaseMeta(baseDir()))?.ignore ?? []
}

describe('runIgnoreCommand', () => {
  it('init seeds the base with default patterns', async () => {
    const out = await runIgnoreCommand(['init', '--base', BASE])
    expect(out).toContain('Seeded ignore patterns')
    const patterns = await ignore()
    expect(patterns).toContain('node_modules/')
    expect(patterns.length).toBeGreaterThan(0)
  })

  it('init preserves the base repos (merge-on-write)', async () => {
    const repo: GitRepoMeta = {
      gitUrl: 'https://example.com/acme/app',
      gitBranch: 'main',
      slug: 'acme-app',
      dir: 'repos/acme-app',
      lastSyncedSha: 'abc',
      lastSyncedAt: new Date().toISOString(),
    }
    await writeBaseMeta(baseDir(), { repos: [repo] })

    await runIgnoreCommand(['init', '--base', BASE])

    const meta = await readBaseMeta(baseDir())
    expect(meta?.repos).toHaveLength(1)
    expect(meta?.repos[0]?.slug).toBe('acme-app')
    expect(meta?.ignore).toContain('node_modules/')
  })

  it('add appends new patterns and dedupes', async () => {
    await runIgnoreCommand(['add', '*.tmp', 'drafts/', '--base', BASE])
    expect(await ignore()).toEqual(['*.tmp', 'drafts/'])

    await runIgnoreCommand(['add', '*.tmp', 'secret.md', '--base', BASE])
    expect(await ignore()).toEqual(['*.tmp', 'drafts/', 'secret.md'])
  })

  it('add without patterns throws a usage error', async () => {
    await expect(runIgnoreCommand(['add', '--base', BASE])).rejects.toBeInstanceOf(
      IgnoreCommandError
    )
  })

  it('list reports the base patterns', async () => {
    await runIgnoreCommand(['add', 'dist/', '--base', BASE])
    const out = await runIgnoreCommand(['list', '--base', BASE])
    expect(out).toContain(`Base: ${BASE}`)
    expect(out).toContain('dist/')
  })

  it('throws when no base can be resolved', async () => {
    // cwd has no .kb file and no active/default base is configured.
    await expect(runIgnoreCommand(['list'], { cwd: tempHome })).rejects.toBeInstanceOf(
      IgnoreCommandError
    )
  })
})
