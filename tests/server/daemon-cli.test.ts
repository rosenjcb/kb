import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pidFilePath,
  readLivePid,
  removePidFile,
  resolveDaemonPort,
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
  it('[TC-82] reads --port, then PORT, then the default', () => {
    expect(resolveDaemonPort(['--port', '4000'])).toBe(4000)
    process.env.PORT = '5000'
    expect(resolveDaemonPort([])).toBe(5000)
    process.env.PORT = undefined
    expect(resolveDaemonPort([])).toBe(38117)
  })
})

describe('pid file lifecycle', () => {
  it('[TC-83] writePidFile/readLivePid round-trips the running pid', () => {
    writePidFile(process.pid)
    expect(readFileSync(pidFilePath(), 'utf8').trim()).toBe(String(process.pid))
    expect(readLivePid()).toBe(process.pid)
  })

  it('[TC-84] readLivePid returns null for a stale pid file (dead process)', () => {
    writePidFile(process.pid) // ensures the run dir exists
    // 2^31-2 is not a live pid; process.kill(pid, 0) throws ESRCH.
    writeFileSync(pidFilePath(), '2147483646\n', 'utf8')
    expect(readLivePid()).toBeNull()
  })

  it('returns null when there is no pid file', () => {
    expect(readLivePid()).toBeNull()
  })
})
