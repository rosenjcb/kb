import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeBootstrapManifest,
  parseIgnoreEnv,
  parseReposEnv,
  resolveBootstrapPlan,
} from '../../src/server/server-bootstrap'

const ENV_KEYS = [
  'KB_BASE',
  'KB_SERVER_BASE_NAME',
  'KB_GIT_REPOS',
  'KB_SERVER_BASE_GIT_REPOS',
  'KB_IGNORE',
  'KB_SERVER_BASE_IGNORE',
  'KB_SERVER_BOOTSTRAP',
  'KB_BOOTSTRAP_FILE',
  'KB_HOME',
] as const

describe('parseReposEnv', () => {
  it('splits on commas and whitespace, preserving inline #branch', () => {
    expect(parseReposEnv('a.git, b.git#dev  c.git')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
      { url: 'c.git', branch: undefined },
    ])
  })

  it('handles newline-separated multi-line values and ignores blanks', () => {
    expect(parseReposEnv('\n a.git \n\n b.git \n')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: undefined },
    ])
  })

  it('applies the default branch only when no inline branch is given', () => {
    expect(parseReposEnv('a.git b.git#main', 'release')).toEqual([
      { url: 'a.git', branch: 'release' },
      { url: 'b.git', branch: 'main' },
    ])
  })

  it('returns [] for undefined/empty', () => {
    expect(parseReposEnv(undefined)).toEqual([])
    expect(parseReposEnv('   ')).toEqual([])
  })
})

describe('parseIgnoreEnv', () => {
  it('splits on commas and newlines, trimming blanks', () => {
    expect(parseIgnoreEnv('tests/, **/*.spec.ts\nnode_modules/')).toEqual([
      'tests/',
      '**/*.spec.ts',
      'node_modules/',
    ])
  })

  it('returns [] for undefined/empty', () => {
    expect(parseIgnoreEnv(undefined)).toEqual([])
    expect(parseIgnoreEnv('   ')).toEqual([])
  })
})

describe('normalizeBootstrapManifest', () => {
  it('accepts string and object repo entries', () => {
    const m = normalizeBootstrapManifest({
      base: 'acme',
      repos: ['a.git#dev', { url: 'b.git', branch: 'main', ignore: ['dist/', ' coverage '] }],
      ignore: ['tests/', ' vendor '],
    })
    expect(m.base).toBe('acme')
    expect(m.repos).toHaveLength(2)
    expect(m.ignore).toEqual(['tests/', 'vendor'])
    expect(m.repos?.[1]).toEqual({ url: 'b.git', branch: 'main', ignore: ['dist/', 'coverage'] })
  })

  it('throws on non-object input', () => {
    expect(() => normalizeBootstrapManifest([])).toThrow(/JSON object/)
    expect(() => normalizeBootstrapManifest('x')).toThrow(/JSON object/)
  })

  it('throws on malformed fields', () => {
    expect(() => normalizeBootstrapManifest({ base: '' })).toThrow(/"base"/)
    expect(() => normalizeBootstrapManifest({ repos: 'a.git' })).toThrow(/"repos"/)
    expect(() => normalizeBootstrapManifest({ ignore: [1] })).toThrow(/"ignore"/)
    expect(() => normalizeBootstrapManifest({ repos: [{ url: 'a.git', ignore: [1] }] })).toThrow(
      /repo "ignore"/
    )
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

  it('resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE)', async () => {
    process.env.KB_BASE = 'legacy'
    process.env.KB_SERVER_BASE_NAME = 'preferred'
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.base).toBe('preferred')
  })

  it('lets --base flag win over env and manifest', async () => {
    process.env.KB_SERVER_BASE_NAME = 'fromenv'
    writeFileSync(path.join(cwd, 'kb-server.json'), JSON.stringify({ base: 'frommanifest' }))
    const plan = await resolveBootstrapPlan(['--base', 'fromflag'], cwd)
    expect(plan.base).toBe('fromflag')
  })

  it('lets explicit env base win over the manifest base', async () => {
    process.env.KB_BASE = 'fromenv'
    writeFileSync(path.join(cwd, 'kb-server.json'), JSON.stringify({ base: 'frommanifest' }))
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.base).toBe('fromenv')
  })

  it('reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS)', async () => {
    process.env.KB_GIT_REPOS = 'legacy.git'
    process.env.KB_SERVER_BASE_GIT_REPOS = 'a.git, b.git#dev'
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.source).toBe('env')
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
    ])
  })

  it('lets --git flags win over env repos', async () => {
    process.env.KB_SERVER_BASE_GIT_REPOS = 'env.git'
    const plan = await resolveBootstrapPlan(['--git', 'flag.git#main'], cwd)
    expect(plan.source).toBe('flags')
    expect(plan.gitTargets).toEqual([{ url: 'flag.git', branch: 'main' }])
  })

  it('falls back to the manifest repos + ignore when no flags/env', async () => {
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

  it('preserves per-repo ignore patterns from the manifest', async () => {
    writeFileSync(
      path.join(cwd, 'kb-server.json'),
      JSON.stringify({
        repos: [
          { url: 'a.git', ignore: ['tests/'] },
          { url: 'b.git', branch: 'develop', ignore: ['dist/', '.next/'] },
        ],
      })
    )
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: undefined, ignorePatterns: ['tests/'] },
      { url: 'b.git', branch: 'develop', ignorePatterns: ['dist/', '.next/'] },
    ])
  })

  it('reads ignore patterns from KB_SERVER_BASE_IGNORE (preferred over KB_IGNORE)', async () => {
    process.env.KB_IGNORE = 'legacy/'
    process.env.KB_SERVER_BASE_IGNORE = 'tests/, **/*.spec.ts'
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.ignore).toEqual(['tests/', '**/*.spec.ts'])
  })

  it('lets env ignore win over manifest ignore', async () => {
    process.env.KB_SERVER_BASE_IGNORE = 'env-only/'
    writeFileSync(
      path.join(cwd, 'kb-server.json'),
      JSON.stringify({
        repos: ['a.git'],
        ignore: ['manifest-only/'],
      })
    )
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.ignore).toEqual(['env-only/'])
  })

  it('honors an explicit --bootstrap path', async () => {
    const file = path.join(cwd, 'custom.json')
    writeFileSync(file, JSON.stringify({ repos: ['x.git'] }))
    const plan = await resolveBootstrapPlan(['--bootstrap', file], cwd)
    expect(plan.source).toBe('manifest')
    expect(plan.gitTargets).toEqual([{ url: 'x.git', branch: undefined }])
  })

  it('reports source "none" when nothing is declared', async () => {
    const plan = await resolveBootstrapPlan([], cwd)
    expect(plan.source).toBe('none')
    expect(plan.gitTargets).toEqual([])
    expect(plan.base).toBeUndefined()
  })

  it('applies --branch as the default branch for targets without an inline pin', async () => {
    const plan = await resolveBootstrapPlan(['--git', 'a.git', '--git', 'b.git#x', '--branch', 'rel'], cwd)
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: 'rel' },
      { url: 'b.git', branch: 'x' },
    ])
  })
})
