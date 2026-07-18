import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BootstrapPlan } from '@kb/server/server-bootstrap.js'
import { resolveServerBaseDir } from '@kb/server/server-cli.js'

/**
 * `kb-server start` must never require naming a base to boot: with no `--base`,
 * no `KB_SERVER_BASE_NAME` / `KB_BASE`, and no locally-selected base, it binds
 * the golden default slug `base` (issue #173, Postgres's maintenance-DB model).
 */
describe('resolveServerBaseDir golden default', () => {
  const ENV_KEYS = ['KB_HOME', 'KB_BASE', 'KB_ACTIVE_BASE'] as const
  let saved: Record<string, string | undefined>
  let home: string

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    home = await mkdtemp(path.join(tmpdir(), 'kb-base-default-'))
    process.env.KB_HOME = home
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  const emptyPlan: BootstrapPlan = { gitTargets: [], source: 'none' }

  it('binds slug "base" when no base is declared and none is selected locally', async () => {
    const resolved = await resolveServerBaseDir(emptyPlan)
    expect(resolved.baseRef).toBe('base')
    expect(resolved.baseDir).toBe(path.join(home, 'sessions', 'base'))
  })

  it('honors an explicit plan base over the golden default', async () => {
    const resolved = await resolveServerBaseDir({ ...emptyPlan, base: 'acme' })
    expect(resolved.baseRef).toBe('acme')
    expect(resolved.baseDir).toBe(path.join(home, 'sessions', 'acme'))
  })
})
