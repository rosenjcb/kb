import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runServiceCommand } from '@kb/server/service-cli.js'

let tmpHome: string
const prevHome = process.env.HOME
const prevKbHome = process.env.KB_HOME
const prevInstallRoot = process.env.KB_INSTALL_ROOT

function silentLogger() {
  const lines: string[] = []
  return { logger: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }, lines }
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'kb-service-'))
  // Redirect os.homedir() (HOME) + KB_HOME so nothing touches the real profile.
  process.env.HOME = tmpHome
  process.env.KB_HOME = path.join(tmpHome, '.kb')
  process.env.KB_INSTALL_ROOT = path.join(tmpHome, '.kb')
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  restore('HOME', prevHome)
  restore('KB_HOME', prevKbHome)
  restore('KB_INSTALL_ROOT', prevInstallRoot)
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('runServiceCommand install --no-start', () => {
  it('[TC-85] writes a service unit that launches the resolved binary, without starting it', async () => {
    const { logger } = silentLogger()
    await runServiceCommand(['install', '--no-start'], logger)

    const unitPath =
      process.platform === 'darwin'
        ? path.join(tmpHome, 'Library', 'LaunchAgents', 'com.kb.server.plist')
        : path.join(tmpHome, '.config', 'systemd', 'user', 'kb-server.service')

    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      // Unsupported platform: no unit written, exit code set.
      expect(existsSync(unitPath)).toBe(false)
      return
    }

    expect(existsSync(unitPath)).toBe(true)
    const unit = readFileSync(unitPath, 'utf8')
    // Falls back to the running binary (no ~/.kb/bin/kb-server in the sandbox),
    // and always launches `start --with-mcp` — never a repo dist path.
    expect(unit).toContain('start')
    expect(unit).toContain('--with-mcp')
    expect(unit).toContain(process.execPath)
    expect(unit).not.toContain('/dist/bin/kb-server')
  })
})
