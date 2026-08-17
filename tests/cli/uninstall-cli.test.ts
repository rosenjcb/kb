import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  performClientUninstall,
  performServerUninstall,
} from '@kb/core/cli/release-uninstall.js'
import { runUninstallCommand } from '@kb/client/cli/uninstall-cli.js'
import { runServerUninstallCommand } from '@kb/server/uninstall-cli.js'

const TMP_KB_HOME = path.join(os.tmpdir(), 'kb-uninstall-test')

function makeOut() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    out: {
      log: (msg: string) => lines.push(msg),
      error: (msg: string) => errors.push(msg),
      write: (chunk: string) => lines.push(chunk),
    },
    lines,
    errors,
  }
}

async function setupDualInstall() {
  const binDir = path.join(TMP_KB_HOME, 'bin')
  const clientRuntime = path.join(TMP_KB_HOME, 'runtime', 'client')
  const serverRuntime = path.join(TMP_KB_HOME, 'runtime', 'server')
  const sessionsDir = path.join(TMP_KB_HOME, 'sessions')
  const activeBaseFile = path.join(TMP_KB_HOME, 'state', 'active-base')
  const kbLink = path.join(binDir, 'kb')
  const serverLink = path.join(binDir, 'kb-server')
  const clientBin = path.join(clientRuntime, 'node_modules', '.bin', 'kb')
  const serverBin = path.join(serverRuntime, 'node_modules', '.bin', 'kb-server')

  await rm(TMP_KB_HOME, { recursive: true, force: true })
  await mkdir(binDir, { recursive: true })
  await mkdir(path.dirname(clientBin), { recursive: true })
  await mkdir(path.dirname(serverBin), { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(path.dirname(activeBaseFile), { recursive: true })
  await writeFile(activeBaseFile, 'demo\n')
  await writeFile(clientBin, '#!/bin/sh\n', 'utf8')
  await writeFile(serverBin, '#!/bin/sh\n', 'utf8')
  await symlink(clientBin, kbLink)
  await symlink(serverBin, serverLink)

  return { binDir, clientRuntime, serverRuntime, sessionsDir, activeBaseFile, kbLink, serverLink }
}

beforeEach(() => {
  process.env.KB_INSTALL_ROOT = TMP_KB_HOME
  process.env.KB_HOME = TMP_KB_HOME
})

afterEach(async () => {
  delete process.env.KB_INSTALL_ROOT
  delete process.env.KB_HOME
  await rm(TMP_KB_HOME, { recursive: true, force: true })
})

describe('performClientUninstall', () => {
  it('[TC-3678] removes kb client only and keeps kb-server + server data', async () => {
    const { kbLink, serverLink, clientRuntime, serverRuntime, sessionsDir, activeBaseFile } =
      await setupDualInstall()
    const { out, lines } = makeOut()

    await performClientUninstall(out)

    expect(lines.some(l => l.includes('bin/kb'))).toBe(true)
    expect(lines.some(l => l.includes('runtime/client'))).toBe(true)
    expect(lines.some(l => l.includes('kb-server'))).toBe(false)

    const { access } = await import('node:fs/promises')
    await expect(access(kbLink)).rejects.toThrow()
    await expect(access(clientRuntime)).rejects.toThrow()
    await expect(access(serverLink)).resolves.toBeUndefined()
    await expect(access(serverRuntime)).resolves.toBeUndefined()
    await expect(access(sessionsDir)).resolves.toBeUndefined()
    await expect(access(activeBaseFile)).resolves.toBeUndefined()
  })
})

describe('performServerUninstall', () => {
  it('[TC-VGQ5] without purge removes kb-server runtime only', async () => {
    const { serverLink, serverRuntime, sessionsDir, activeBaseFile, kbLink } = await setupDualInstall()
    const { out } = makeOut()

    await performServerUninstall({ purge: false }, out)

    const { access } = await import('node:fs/promises')
    await expect(access(serverLink)).rejects.toThrow()
    await expect(access(serverRuntime)).rejects.toThrow()
    await expect(access(kbLink)).resolves.toBeUndefined()
    await expect(access(sessionsDir)).resolves.toBeUndefined()
    await expect(access(activeBaseFile)).resolves.toBeUndefined()
  })

  it('[TC-CCMI] with purge removes server data but keeps kb client install', async () => {
    const { serverLink, kbLink, clientRuntime, sessionsDir, activeBaseFile } = await setupDualInstall()
    const { out } = makeOut()

    await performServerUninstall({ purge: true }, out)

    const { access } = await import('node:fs/promises')
    await expect(access(serverLink)).rejects.toThrow()
    await expect(access(sessionsDir)).rejects.toThrow()
    await expect(access(activeBaseFile)).rejects.toThrow()
    await expect(access(kbLink)).resolves.toBeUndefined()
    await expect(access(clientRuntime)).resolves.toBeUndefined()
  })
})

describe('runUninstallCommand', () => {
  it('[TC-NMA1] rejects --purge with server guidance', async () => {
    const { out, errors } = makeOut()
    await runUninstallCommand(['--purge'], out)
    expect(errors.some(e => e.includes('kb-server uninstall --purge'))).toBe(true)
  })

  it('[TC-4FS5] --yes removes client without prompting', async () => {
    const { kbLink, serverLink } = await setupDualInstall()
    const { out } = makeOut()

    await runUninstallCommand(['--yes'], out)

    const { access } = await import('node:fs/promises')
    await expect(access(kbLink)).rejects.toThrow()
    await expect(access(serverLink)).resolves.toBeUndefined()
  })
})

describe('runServerUninstallCommand', () => {
  it('[TC-0XNN] --purge deletes server data', async () => {
    await setupDualInstall()
    const { out } = makeOut()

    await runServerUninstallCommand(['--purge', '--yes'], out)

    const { access } = await import('node:fs/promises')
    await expect(access(path.join(TMP_KB_HOME, 'sessions'))).rejects.toThrow()
    await expect(access(path.join(TMP_KB_HOME, 'state', 'active-base'))).rejects.toThrow()
  })
})

describe('PATH cleanup', () => {
  it('[TC-5X7H] removes PATH entry only when both binaries are gone', async () => {
    const { kbLink, serverLink } = await setupDualInstall()
    const fakeRcFile = path.join(TMP_KB_HOME, '.bashrc')
    const kbBinDir = path.join(TMP_KB_HOME, 'bin')
    await writeFile(fakeRcFile, `export PATH="${kbBinDir}:$PATH"\necho hello\n`)

    const originalHome = os.homedir()
    Object.defineProperty(os, 'homedir', { value: () => TMP_KB_HOME, configurable: true })
    try {
      const { out: clientOut } = makeOut()
      await performClientUninstall(clientOut)
      const mid = await readFile(fakeRcFile, 'utf8')
      expect(mid).toContain(`export PATH="${kbBinDir}:$PATH"`)

      const { out: serverOut, lines } = makeOut()
      await performServerUninstall({ purge: false }, serverOut)
      const final = await readFile(fakeRcFile, 'utf8')
      expect(final).not.toContain(`export PATH="${kbBinDir}:$PATH"`)
      expect(lines.some(l => l.includes('.bashrc'))).toBe(true)
    } finally {
      Object.defineProperty(os, 'homedir', { value: () => originalHome, configurable: true })
    }

    void kbLink
    void serverLink
  })
})
