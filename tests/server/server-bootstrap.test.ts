import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseReposEnv, resolveBootstrapPlan } from '@kb/server/server-bootstrap.js'

const ENV_KEYS = [
  'KB_BASE',
  'KB_SERVER_BASE_NAME',
  'KB_GIT_REPOS',
  'KB_SERVER_BASE_GIT_REPOS',
  'KB_SERVER_IGNORE',
] as const

describe('parseReposEnv', () => {
  it('[TC-6JDU] splits on commas and whitespace, preserving inline #branch', () => {
    expect(parseReposEnv('a.git, b.git#dev  c.git')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
      { url: 'c.git', branch: undefined },
    ])
  })

  it('[TC-6SG4] handles newline-separated multi-line values and ignores blanks', () => {
    expect(parseReposEnv('\n a.git \n\n b.git \n')).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: undefined },
    ])
  })

  it('[TC-O0YC] applies the default branch only when no inline branch is given', () => {
    expect(parseReposEnv('a.git b.git#main', 'release')).toEqual([
      { url: 'a.git', branch: 'release' },
      { url: 'b.git', branch: 'main' },
    ])
  })

  it('[TC-C759] returns [] for undefined/empty', () => {
    expect(parseReposEnv(undefined)).toEqual([])
    expect(parseReposEnv('   ')).toEqual([])
  })
})

describe('resolveBootstrapPlan', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('[TC-L9F8] resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE)', async () => {
    process.env.KB_BASE = 'legacy'
    process.env.KB_SERVER_BASE_NAME = 'preferred'
    const plan = await resolveBootstrapPlan([])
    expect(plan.base).toBe('preferred')
  })

  it('[TC-JT2B] lets the --base flag win over env', async () => {
    process.env.KB_SERVER_BASE_NAME = 'fromenv'
    const plan = await resolveBootstrapPlan(['--base', 'fromflag'])
    expect(plan.base).toBe('fromflag')
  })

  it('[TC-C3QO] reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS)', async () => {
    process.env.KB_GIT_REPOS = 'legacy.git'
    process.env.KB_SERVER_BASE_GIT_REPOS = 'a.git, b.git#dev'
    const plan = await resolveBootstrapPlan([])
    expect(plan.source).toBe('env')
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: undefined },
      { url: 'b.git', branch: 'dev' },
    ])
  })

  it('[TC-Z0WI] lets --git flags win over env repos', async () => {
    process.env.KB_SERVER_BASE_GIT_REPOS = 'env.git'
    const plan = await resolveBootstrapPlan(['--git', 'flag.git#main'])
    expect(plan.source).toBe('flags')
    expect(plan.gitTargets).toEqual([{ url: 'flag.git', branch: 'main' }])
  })

  it('[TC-PNLO] reads ignore patterns from KB_SERVER_IGNORE', async () => {
    process.env.KB_SERVER_BASE_GIT_REPOS = 'a.git'
    process.env.KB_SERVER_IGNORE = 'tests/, **/*.spec.ts'
    const plan = await resolveBootstrapPlan([])
    expect(plan.ignore).toEqual(['tests/', '**/*.spec.ts'])
  })

  it('[TC-H3UU] reports source "none" and no ignore when nothing is declared', async () => {
    const plan = await resolveBootstrapPlan([])
    expect(plan.source).toBe('none')
    expect(plan.gitTargets).toEqual([])
    expect(plan.base).toBeUndefined()
    expect(plan.ignore).toBeUndefined()
  })

  it('[TC-NAUJ] applies --branch as the default branch for targets without an inline pin', async () => {
    const plan = await resolveBootstrapPlan(['--git', 'a.git', '--git', 'b.git#x', '--branch', 'rel'])
    expect(plan.gitTargets).toEqual([
      { url: 'a.git', branch: 'rel' },
      { url: 'b.git', branch: 'x' },
    ])
  })
})
