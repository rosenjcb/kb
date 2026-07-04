import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeBootstrapManifest,
  parseReposEnv,
  resolveBootstrapPlan,
} from '@kb/server/server-bootstrap.js'

const ENV_KEYS = [
  'KB_BASE',
  'KB_SERVER_BASE_NAME',
  'KB_GIT_REPOS',
  'KB_SERVER_BASE_GIT_REPOS',
  'KB_SERVER_BOOTSTRAP',
  'KB_BOOTSTRAP_FILE',
  'KB_HOME',
] as const

describe('parseReposEnv', () => {
                it('[TC-36] splits on commas and whitespace, preserving inline #branch', () => {
    expect(parseReposEnv('a.git, b.git#dev  c.git')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
      { url: 'c.git', branch: undefined },
    ])
  })

                it('[TC-37] handles newline-separated multi-line values and ignores blanks', () => {
    expect(parseReposEnv('\n a.git \n\n b.git \n')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: undefined },
    ])
  })

                it('[TC-38] applies the default branch only when no inline branch is given', () => {
    expect(parseReposEnv('a.git b.git#main', 'release')).toEqual([
      { url: 'a.git', branch: 'release' },
      { url: 'b.git', branch: 'main' },
    ])
  })

                it('[TC-39] returns [] for undefined/empty', () => {
    expect(parseReposEnv(undefined)).toEqual([])
    expect(parseReposEnv('   ')).toEqual([])
  })
})

describe('normalizeBootstrapManifest', () => {
                it('[TC-40] accepts string and object repo entries', () => {
    const m = normalizeBootstrapManifest({
      base: 'acme',
      repos: ['a.git#dev', { url: 'b.git', branch: 'main' }],
      ignore: ['tests/', ' vendor '],
    })
    expect(m.base).toBe('acme')
    expect(m.repos).toHaveLength(2)
    expect(m.ignore).toEqual(['tests/', 'vendor'])
  })

                it('[TC-41] throws on non-object input', () => {
    expect(() => normalizeBootstrapManifest([])).toThrow(/JSON object/)
    expect(() => normalizeBootstrapManifest('x')).toThrow(/JSON object/)
  })

                it('[TC-42] throws on malformed fields', () => {
    expect(() => normalizeBootstrapManifest({ base: '' })).toThrow(/"base"/)
    expect(() => normalizeBootstrapManifest({ repos: 'a.git' })).toThrow(/"repos"/)
    expect(() => normalizeBootstrapManifest({ ignore: [1] })).toThrow(/"ignore"/)
  })
})

describe('resolveBootstrapPlan', () => {
  let saved: Record<string, string | undefined>
  let cwd: string

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    cwd = mkdtempSync(path.join(tmpdir(), 'kb-bootstrap-'))
    // Isolate the KB_HOME manifest candidate to an empty dir.
    process.env.KB_HOME = mkdtempSync(path.join(tmpdir(), 'kb-home-'))
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(cwd, { recursive: true, force: true })
  })

                it('[TC-43] resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE)', async () => {
    process.env.KB_BASE = 'legacy'
    process.env.KB_SERVER_BASE_NAME = 'preferred'
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.base).toBe('preferred')
  })

                it('[TC-44] lets --base flag win over env and manifest', async () => {
    process.env.KB_SERVER_BASE_NAME = 'fromenv'
    writeFileSync(path.join(cwd, 'kb-server.json'), JSON.stringify({ base: 'frommanifest' }))
    const plan = await resolveBootstrapPlan(['--base', 'fromflag'], cwd)
    expect(plan.base).toBe('fromflag')
  })

                it('[TC-45] lets explicit env base win over the manifest base', async () => {
    process.env.KB_BASE = 'fromenv'
    writeFileSync(path.join(cwd, 'kb-server.json'), JSON.stringify({ base: 'frommanifest' }))
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.base).toBe('fromenv')
  })

                it('[TC-46] reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS)', async () => {
    process.env.KB_GIT_REPOS = 'legacy.git'
    process.env.KB_SERVER_BASE_GIT_REPOS = 'a.git, b.git#dev'
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.source).toBe('env')
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
    ])
  })

                it('[TC-47] lets --git flags win over env repos', async () => {
    process.env.KB_SERVER_BASE_GIT_REPOS = 'env.git'
    const plan = await resolveBootstrapPlan(['--git', 'flag.git#main'], cwd)
    expect(plan.source).toBe('flags')
    expect(plan.gitTargets).toEqual([{ url: 'flag.git', branch: 'main' }])
  })

                it('[TC-48] falls back to the manifest repos + ignore when no flags/env', async () => {
    writeFileSync(
      path.join(cwd, 'kb-server.json'),
      JSON.stringify({
        base: 'acme',
        repos: ['a.git', { url: 'b.git', branch: 'develop' }],
        ignore: ['tests/'],
      })
    )
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.source).toBe('manifest')
    expect(plan.base).toBe('acme')
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'develop' },
    ])
    expect(plan.ignore).toEqual(['tests/'])
  })

                it('[TC-49] honors an explicit --bootstrap path', async () => {
    const file = path.join(cwd, 'custom.json')
    writeFileSync(file, JSON.stringify({ repos: ['x.git'] }))
    const plan = await resolveBootstrapPlan(['--bootstrap', file], cwd)
    expect(plan.source).toBe('manifest')
    expect(plan.gitTargets).toEqual([{ url: 'x.git', branch: undefined }])
  })

  it('[TC-50] reports source "none" when nothing is declared', async () => {
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.source).toBe('none')
    expect(plan.gitTargets).toEqual([])
    expect(plan.base).toBeUndefined()
  })

                it('[TC-51] applies --branch as the default branch for targets without an inline pin', async () => {
    const plan = await resolveBootstrapPlan(['--git', 'a.git', '--git', 'b.git#x', '--branch', 'rel'], cwd)
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: 'rel' },
      { url: 'b.git', branch: 'x' },
    ])
  })
})
