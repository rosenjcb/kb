import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { performUninstall, runUninstallCommand } from '../../src/cli/uninstall-cli'

const TMP_KB_HOME = path.join(os.tmpdir(), 'kb-uninstall-cli-test')

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

async function setupFakeInstall() {
  const binDir = path.join(TMP_KB_HOME, 'bin')
  const runtimeDir = path.join(TMP_KB_HOME, 'runtime')
  const pythonDir = path.join(TMP_KB_HOME, '.kb-python')
  const binLink = path.join(binDir, 'kb')

  await rm(TMP_KB_HOME, { recursive: true, force: true })
  await mkdir(binDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(pythonDir, { recursive: true })
  await symlink('/usr/bin/node', binLink)

  return { binDir, runtimeDir, pythonDir, binLink }
}

beforeEach(() => {
  process.env.KB_INSTALL_ROOT = TMP_KB_HOME
})

afterEach(async () => {
  delete process.env.KB_INSTALL_ROOT
  await rm(TMP_KB_HOME, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// performUninstall
// ---------------------------------------------------------------------------

describe('performUninstall', () => {
  it('removes binary symlink, runtime dir, and Python venv', async () => {
    const { binLink, runtimeDir, pythonDir } = await setupFakeInstall()
    const { out, lines } = makeOut()

    await performUninstall({ yes: true, purge: false }, out)

    expect(lines.some(l => l.includes('bin/kb'))).toBe(true)
    expect(lines.some(l => l.includes('runtime'))).toBe(true)
    expect(lines.some(l => l.includes('.kb-python'))).toBe(true)

    const { access } = await import('node:fs/promises')
    await expect(access(binLink)).rejects.toThrow()
    await expect(access(runtimeDir)).rejects.toThrow()
    await expect(access(pythonDir)).rejects.toThrow()
  })

  it('does not remove ~/.kb when purge is false', async () => {
    await setupFakeInstall()
    const { out } = makeOut()

    await performUninstall({ yes: true, purge: false }, out)

    const { access } = await import('node:fs/promises')
    await expect(access(TMP_KB_HOME)).resolves.toBeUndefined()
  })

  it('removes ~/.kb entirely when purge is true', async () => {
    await setupFakeInstall()
    const { out } = makeOut()

    await performUninstall({ yes: true, purge: true }, out)

    const { access } = await import('node:fs/promises')
    await expect(access(TMP_KB_HOME)).rejects.toThrow()
  })

  it('skips missing paths silently', async () => {
    await rm(TMP_KB_HOME, { recursive: true, force: true })
    const { out, lines } = makeOut()

    await performUninstall({ yes: true, purge: false }, out)

    expect(lines).toHaveLength(0)
  })

  it('removes PATH entries from rc files', async () => {
    await setupFakeInstall()
    const kbBinDir = path.join(TMP_KB_HOME, 'bin')
    const fakeRcFile = path.join(TMP_KB_HOME, '.bashrc')
    await writeFile(fakeRcFile, `export PATH="${kbBinDir}:$PATH"\necho hello\n`)

    const { out, lines } = makeOut()
    const originalHome = os.homedir()
    Object.defineProperty(os, 'homedir', { value: () => TMP_KB_HOME, configurable: true })
    try {
      await performUninstall({ yes: true, purge: false }, out)
    } finally {
      Object.defineProperty(os, 'homedir', { value: () => originalHome, configurable: true })
    }

    const remaining = await readFile(fakeRcFile, 'utf8')
    expect(remaining).not.toContain(`export PATH="${kbBinDir}:$PATH"`)
    expect(remaining).toContain('echo hello')
    expect(lines.some(l => l.includes('.bashrc'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runUninstallCommand — flag parsing
// ---------------------------------------------------------------------------

describe('runUninstallCommand', () => {
  it('rejects non-TTY without --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    const { out, errors } = makeOut()
    await runUninstallCommand([], out)
    expect(errors.some(e => e.includes('interactive terminal'))).toBe(true)
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  })

  it('--yes removes binary, runtime, and Python env without prompting', async () => {
    const { binLink, runtimeDir, pythonDir } = await setupFakeInstall()
    const { out, lines } = makeOut()

    await runUninstallCommand(['--yes'], out)

    const { access } = await import('node:fs/promises')
    await expect(access(binLink)).rejects.toThrow()
    await expect(access(runtimeDir)).rejects.toThrow()
    await expect(access(pythonDir)).rejects.toThrow()
    expect(lines.some(l => l.includes('KB has been uninstalled'))).toBe(true)
    // user data kept
    await expect(access(TMP_KB_HOME)).resolves.toBeUndefined()
  })

  it('--purge removes everything including ~/.kb', async () => {
    await setupFakeInstall()
    const { out } = makeOut()

    await runUninstallCommand(['--purge'], out)

    const { access } = await import('node:fs/promises')
    await expect(access(TMP_KB_HOME)).rejects.toThrow()
  })

  it('lists Python environment in the removal plan', async () => {
    await setupFakeInstall()
    const { out, lines } = makeOut()

    await runUninstallCommand(['--yes'], out)

    expect(lines.some(l => l.includes('.kb-python'))).toBe(true)
  })
})
