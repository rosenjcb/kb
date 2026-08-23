import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => ({ pid: process.pid, unref: vi.fn() })),
  }
})

import {
  pidFilePath,
  readLivePid,
  removePidFile,
  resolveDaemonPort,
  runServerStartDaemon,
  writePidFile,
} from '@kb/server/daemon-cli.js'

let tmpHome: string
const prevKbHome = process.env.KB_HOME
const prevPort = process.env.PORT

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'kb-daemon-'))
  process.env.KB_HOME = tmpHome
  delete process.env.PORT
})

afterEach(() => {
  removePidFile()
  rmSync(tmpHome, { recursive: true, force: true })
  if (prevKbHome === undefined) delete process.env.KB_HOME
  else process.env.KB_HOME = prevKbHome
  if (prevPort === undefined) delete process.env.PORT
  else process.env.PORT = prevPort
})

describe('resolveDaemonPort', () => {
  it('[TC-SYYS] reads --port, then PORT, then the default', () => {
    expect(resolveDaemonPort(['--port', '4000'])).toBe(4000)
    process.env.PORT = '5000'
    expect(resolveDaemonPort([])).toBe(5000)
    delete process.env.PORT
    expect(resolveDaemonPort([])).toBe(38117)
  })
})

describe('pid file lifecycle', () => {
  it('[TC-9GUC] writePidFile/readLivePid round-trips the running pid', () => {
    writePidFile(process.pid)
    expect(readFileSync(pidFilePath(), 'utf8').trim()).toBe(String(process.pid))
    expect(readLivePid()).toBe(process.pid)
  })

  it('[TC-N9EM] readLivePid returns null for a stale pid file (dead process)', () => {
    writePidFile(process.pid) // ensures the run dir exists
    // 2^31-2 is not a live pid; process.kill(pid, 0) throws ESRCH.
    writeFileSync(pidFilePath(), '2147483646\n', 'utf8')
    expect(readLivePid()).toBeNull()
  })

  it('returns null when there is no pid file', () => {
    expect(readLivePid()).toBeNull()
  })
})

describe('runServerStartDaemon client-scoped env warning', () => {
  const prevBase = process.env.KB_BASE
  const prevServerBase = process.env.KB_SERVER_BASE_NAME

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: true }) }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
    if (prevServerBase === undefined) delete process.env.KB_SERVER_BASE_NAME
    else process.env.KB_SERVER_BASE_NAME = prevServerBase
  })

  it('[TC-DMW1] warns in the parent process before detaching, so `start -d` surfaces the same collision an operator watching only the foreground shell would otherwise miss', async () => {
    process.env.KB_BASE = 'raylib'
    delete process.env.KB_SERVER_BASE_NAME
    const out = { log: vi.fn(), error: vi.fn() }

    await runServerStartDaemon([], out)

    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('KB_BASE'))
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('KB_SERVER_BASE_NAME'))
  })

  it('[TC-DMW2] does not warn when the client-scoped vars are unset', async () => {
    delete process.env.KB_BASE
    const out = { log: vi.fn(), error: vi.fn() }

    await runServerStartDaemon([], out)

    expect(out.error).not.toHaveBeenCalledWith(expect.stringContaining('KB_BASE'))
  })
})
