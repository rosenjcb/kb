import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isKbIndexEmpty } from '@kb/core/tools/sqlite-kb-index.js'
import type { BootstrapPlan } from '@kb/server/server-bootstrap.js'
import { resolveServerBaseDir } from '@kb/server/server-cli.js'

/**
 * `kb-server start` must never require naming a base to boot: with no `--base`,
 * no `KB_SERVER_BASE_NAME` / `KB_BASE`, and no locally-selected base, it binds
 * the golden default slug `default` (Postgres's maintenance-DB model).
 */
describe('resolveServerBaseDir golden default', () => {
  const ENV_KEYS = ['KB_HOME', 'KB_BASE', 'KB_ACTIVE_BASE', 'KB_SERVER_BASE_NAME'] as const
  let saved: Record<string, string | undefined>
  let home: string
  let cwd: string
  let prevCwd: string

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    home = await mkdtemp(path.join(tmpdir(), 'kb-base-default-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'kb-base-default-cwd-'))
    process.env.KB_HOME = home
    // Avoid picking up the repo `.kb` / selected base from the workspace cwd.
    prevCwd = process.cwd()
    process.chdir(cwd)
  })

  afterEach(async () => {
    process.chdir(prevCwd)
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  const emptyPlan: BootstrapPlan = { gitTargets: [], source: 'none' }

  it('[TC-GLD1] binds slug "default" when no base is declared and none is selected locally', async () => {
    const resolved = await resolveServerBaseDir(emptyPlan)
    expect(resolved.baseRef).toBe('default')
    expect(resolved.baseDir).toBe(path.join(home, 'sessions', 'default'))
  })

  it('[TC-GLD2] honors an explicit plan base over the golden default', async () => {
    const resolved = await resolveServerBaseDir({ ...emptyPlan, base: 'acme' })
    expect(resolved.baseRef).toBe('acme')
    expect(resolved.baseDir).toBe(path.join(home, 'sessions', 'acme'))
  })

  it('[TC-NOLK] ignores a locally-selected client active base — the server has no state of its own to leak into', async () => {
    process.env.KB_ACTIVE_BASE = 'raylib'
    const resolved = await resolveServerBaseDir(emptyPlan)
    expect(resolved.baseRef).toBe('default')
    expect(resolved.baseDir).toBe(path.join(home, 'sessions', 'default'))
  })

  it('[TC-SLF1] self-heals: materializes a real, empty, migrated index even though `kb-server init` never ran', async () => {
    const resolved = await resolveServerBaseDir(emptyPlan)
    const dbPath = path.join(resolved.baseDir, '.kb-index.sqlite')
    expect(existsSync(dbPath)).toBe(true)
    expect(isKbIndexEmpty(dbPath)).toBe(true)
  })
})
