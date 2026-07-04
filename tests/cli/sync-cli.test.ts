import { lstat, readlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '@kb/client/cli/sync-cli.js'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node24.tgz'
const RELEASE_INSTALLER_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh'
const TEST_KB_HOME = path.join(os.tmpdir(), 'kb-sync-cli-test-home')
const TEST_RUNTIME_DIR = path.join(TEST_KB_HOME, 'runtime')
const TEST_BIN_LINK = path.join(TEST_KB_HOME, 'bin', 'kb')
const TEST_PACKAGE_BIN = path.join(TEST_RUNTIME_DIR, 'node_modules', '.bin', 'kb')

// Deterministic managed-runtime stand-in so the test does not depend on the
// machine's nvm layout or which Node runs the suite.
const FAKE_NODE_BIN = '/fake/nvm/versions/node/v24.15.0/bin/node'
const FAKE_NPM_CLI = '/fake/nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js'
const FAKE_RUNTIME = { nodeBin: FAKE_NODE_BIN, npmCli: FAKE_NPM_CLI }

describe('sync-cli', () => {
  it('[TC-486] Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain(RELEASE_INSTALLER_URL)
    expect(printSyncHelp()).toContain("managed Node 24 runtime")
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('[TC-487] Given no flags, then sync installs the latest release tarball into ~/.kb and links a stable binary', async () => {
    process.env.KB_INSTALL_ROOT = TEST_KB_HOME
    await rm(TEST_KB_HOME, { recursive: true, force: true })

    const expectedCommand = FAKE_NODE_BIN
    const expectedArgs = [
      FAKE_NPM_CLI,
      'install',
      '--ignore-scripts',
      '--prefix',
      TEST_RUNTIME_DIR,
      RELEASE_TARBALL_URL,
    ]

    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const runCommand = vi.fn(
      async (
        command: string,
        args: string[],
        _cwd: string,
        _onProgress?: (line: string) => void,
        env?: NodeJS.ProcessEnv
      ) => {
        calls.push({ command, args, env })
        if (command === expectedCommand && args.join(' ') === expectedArgs.join(' ')) {
          return 'install ok'
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      }
    )

    const progressLines: string[] = []
    const output = await runSyncCommand([], {
      cwd: '/tmp/kb-sync-test',
      runCommand,
      resolveNodeRuntime: () => FAKE_RUNTIME,
      onProgress: line => progressLines.push(line),
    })

    expect(progressLines.some(l => l.includes(RELEASE_TARBALL_URL))).toBe(true)
    expect(progressLines.some(l => l.includes('Downloading'))).toBe(true)
    expect(progressLines.some(l => l.includes(TEST_RUNTIME_DIR))).toBe(true)
    expect(progressLines.some(l => l.includes(TEST_BIN_LINK))).toBe(true)
    expect(progressLines.some(l => l.includes(FAKE_NODE_BIN))).toBe(true)
    expect(output).toContain('Sync complete.')
    expect(output).toContain('install ok')
    expect(output).toContain(`Installed to ${TEST_RUNTIME_DIR}`)
    expect(output).toContain(`Linked ${TEST_BIN_LINK} -> ${TEST_PACKAGE_BIN}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(expectedCommand)
    expect(calls[0]?.args).toEqual(expectedArgs)
    // The managed Node's bin dir is prepended to PATH so npm uses it, not the user's.
    expect(calls[0]?.env?.PATH?.startsWith(path.dirname(FAKE_NODE_BIN) + path.delimiter)).toBe(true)
    expect(runCommand).toHaveBeenCalledTimes(1)

    const stats = await lstat(TEST_BIN_LINK)
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readlink(TEST_BIN_LINK)).toBe(TEST_PACKAGE_BIN)

    delete process.env.KB_INSTALL_ROOT
    await rm(TEST_KB_HOME, { recursive: true, force: true })
  })

  it('[TC-488] Given legacy no-build flag, then sync rejects it', async () => {
    await expect(runSyncCommand(['--no-build'])).rejects.toThrow('Unknown sync flag: --no-build')
  })

  it('[TC-489] Given positional args, then sync rejects them', async () => {
    await expect(runSyncCommand(['extra'])).rejects.toThrow(
      'kb sync does not accept positional arguments.'
    )
  })
})
