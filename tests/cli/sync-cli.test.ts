import { lstat, readlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '../../src/cli/sync-cli'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz'
const RELEASE_INSTALLER_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh'
const TEST_KB_HOME = path.join(os.tmpdir(), 'kb-sync-cli-test-home')
const TEST_RUNTIME_DIR = path.join(TEST_KB_HOME, 'runtime')
const TEST_BIN_LINK = path.join(TEST_KB_HOME, 'bin', 'kb')
const TEST_PACKAGE_BIN = path.join(TEST_RUNTIME_DIR, 'node_modules', '.bin', 'kb')

describe('sync-cli', () => {
  it('Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain(RELEASE_INSTALLER_URL)
    expect(printSyncHelp()).toContain('Node 22+')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('Given no flags, then sync installs the latest release tarball into ~/.kb and links a stable binary', async () => {
    process.env.KB_INSTALL_ROOT = TEST_KB_HOME
    await rm(TEST_KB_HOME, { recursive: true, force: true })

    const calls: string[] = []
    const runCommand = vi.fn(
      async (
        command: string,
        args: string[],
        _cwd: string
      ) => {
        const joined = `${command} ${args.join(' ')}`
        calls.push(joined)
        if (joined === `npm install --prefix ${TEST_RUNTIME_DIR} ${RELEASE_TARBALL_URL}`) {
          return 'install ok'
        }
        throw new Error(`Unexpected command: ${joined}`)
      }
    )

    const progressLines: string[] = []
    const output = await runSyncCommand([], {
      cwd: '/tmp/kb-sync-test',
      runCommand,
      onProgress: line => progressLines.push(line),
    })

    expect(progressLines.some(l => l.includes(RELEASE_TARBALL_URL))).toBe(true)
    expect(progressLines.some(l => l.includes('Downloading'))).toBe(true)
    expect(progressLines.some(l => l.includes(TEST_RUNTIME_DIR))).toBe(true)
    expect(progressLines.some(l => l.includes(TEST_BIN_LINK))).toBe(true)
    expect(output).toContain('Sync complete.')
    expect(output).toContain('install ok')
    expect(output).toContain(`Installed to ${TEST_RUNTIME_DIR}`)
    expect(output).toContain(`Linked ${TEST_BIN_LINK} -> ${TEST_PACKAGE_BIN}`)
    expect(calls).toEqual([`npm install --prefix ${TEST_RUNTIME_DIR} ${RELEASE_TARBALL_URL}`])
    expect(runCommand).toHaveBeenCalledTimes(1)

    const stats = await lstat(TEST_BIN_LINK)
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readlink(TEST_BIN_LINK)).toBe(TEST_PACKAGE_BIN)

    delete process.env.KB_INSTALL_ROOT
    await rm(TEST_KB_HOME, { recursive: true, force: true })
  })

  it('Given legacy no-build flag, then sync rejects it', async () => {
    await expect(runSyncCommand(['--no-build'])).rejects.toThrow('Unknown sync flag: --no-build')
  })

  it('Given positional args, then sync rejects them', async () => {
    await expect(runSyncCommand(['extra'])).rejects.toThrow(
      'kb sync does not accept positional arguments.'
    )
  })
})
