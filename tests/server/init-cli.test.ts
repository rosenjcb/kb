import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BASE_SLUG } from '@kb/core/storage/base-selection.js'
import { isKbIndexEmpty } from '@kb/core/tools/sqlite-kb-index.js'
import { runServerInit } from '@kb/server/init-cli.js'

function makeOut() {
  const lines: string[] = []
  return {
    out: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) },
    lines,
  }
}

let kbHomeDir: string
let prevHome: string | undefined

beforeEach(async () => {
  prevHome = process.env.KB_HOME
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-server-init-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.KB_HOME
  else process.env.KB_HOME = prevHome
  await rm(kbHomeDir, { recursive: true, force: true })
})

describe('kb-server init', () => {
  it('[TC-INI1] creates KB_HOME run/logs/state directories', async () => {
    const { out } = makeOut()
    await runServerInit(out)

    expect(existsSync(path.join(kbHomeDir, 'run'))).toBe(true)
    expect(existsSync(path.join(kbHomeDir, 'logs'))).toBe(true)
    expect(existsSync(path.join(kbHomeDir, 'state'))).toBe(true)
  })

  it('[TC-INI2] unconditionally materializes the reserved "default" base as an empty, migrated index', async () => {
    const { out } = makeOut()
    await runServerInit(out)

    const dbPath = path.join(kbHomeDir, 'sessions', DEFAULT_BASE_SLUG, '.kb-index.sqlite')
    expect(existsSync(dbPath)).toBe(true)
    expect(isKbIndexEmpty(dbPath)).toBe(true)
  })

  it('[TC-INI3] is idempotent — a second run reports the existing base instead of recreating it', async () => {
    const first = makeOut()
    await runServerInit(first.out)
    const dbPath = path.join(kbHomeDir, 'sessions', DEFAULT_BASE_SLUG, '.kb-index.sqlite')
    const firstMtime = (await stat(dbPath)).mtimeMs

    const second = makeOut()
    await runServerInit(second.out)

    expect((await stat(dbPath)).mtimeMs).toBe(firstMtime)
    expect(second.lines.join('\n')).toContain('already exists')
  })

  it('[TC-INI4] records no default-base state — no server-side state file is ever written', async () => {
    const { out } = makeOut()
    await runServerInit(out)

    // The server has no analog to the client's active-base file: init materializes
    // the base but never records "the chosen default" anywhere.
    expect(existsSync(path.join(kbHomeDir, 'state', 'server-base'))).toBe(false)
    expect(existsSync(path.join(kbHomeDir, 'state', 'active-base'))).toBe(false)
  })
})
