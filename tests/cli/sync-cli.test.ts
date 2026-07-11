import { lstat, readlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  KB_CLIENT_RELEASE_TARBALL_URL,
  KB_RELEASE_INSTALLER_URL,
  KB_SERVER_RELEASE_TARBALL_URL,
} from '@kb/core/config/release-artifacts.js'
import { printSyncHelp, runSyncCommand } from '@kb/client/cli/sync-cli.js'

const TEST_KB_HOME = path.join(os.tmpdir(), 'kb-sync-cli-test-home')
const TEST_CLIENT_RUNTIME = path.join(TEST_KB_HOME, 'runtime', 'client')
const TEST_SERVER_RUNTIME = path.join(TEST_KB_HOME, 'runtime', 'server')
const TEST_KB_BIN_LINK = path.join(TEST_KB_HOME, 'bin', 'kb')
const TEST_SERVER_BIN_LINK = path.join(TEST_KB_HOME, 'bin', 'kb-server')
const TEST_KB_PACKAGE_BIN = path.join(TEST_CLIENT_RUNTIME, 'bin', 'kb')
const TEST_SERVER_PACKAGE_BIN = path.join(TEST_SERVER_RUNTIME, 'bin', 'kb-server')

const FAKE_NODE_BIN = '/fake/nvm/versions/node/v24.15.0/bin/node'
const FAKE_RUNTIME = { nodeBin: FAKE_NODE_BIN }

describe('sync-cli', () => {
  it('[TC-417] Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(KB_CLIENT_RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain(KB_SERVER_RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain(KB_RELEASE_INSTALLER_URL)
    expect(printSyncHelp()).toContain('managed Node 24 runtime')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('[TC-418] Given no flags, then sync installs client + server tarballs and links both binaries', async () => {
    process.env.KB_INSTALL_ROOT = TEST_KB_HOME
    await rm(TEST_KB_HOME, { recursive: true, force: true })

    const calls: Array<{ command: string; args: string[] }> = []
    const runCommand = vi.fn(
      async (
        command: string,
        args: string[],
        _cwd: string
      ) => {
        calls.push({ command, args })
        if (command === 'curl') {
          expect(args[0]).toBe('-fsSL')
          expect(args[2]).toBe('-o')
          expect(args[3]).toMatch(/kb-sync-.*\/(client|server)\.tgz$/)
          return ''
        }
        if (command === 'tar') {
          expect(args[0]).toBe('-xzf')
          expect(args[2]).toBe('-C')
          expect([TEST_CLIENT_RUNTIME, TEST_SERVER_RUNTIME]).toContain(args[3])
          return 'extract ok'
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

    expect(progressLines.some(l => l.includes(KB_CLIENT_RELEASE_TARBALL_URL))).toBe(true)
    expect(progressLines.some(l => l.includes(KB_SERVER_RELEASE_TARBALL_URL))).toBe(true)
    expect(output).toContain('Sync complete.')
    expect(output).toContain(`Linked ${TEST_KB_BIN_LINK} -> ${TEST_KB_PACKAGE_BIN}`)
    expect(output).toContain(`Linked ${TEST_SERVER_BIN_LINK} -> ${TEST_SERVER_PACKAGE_BIN}`)
    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual({
      command: 'curl',
      args: ['-fsSL', KB_CLIENT_RELEASE_TARBALL_URL, '-o', calls[0]?.args[3] ?? ''],
    })
    expect(calls[1]).toEqual({
      command: 'tar',
      args: ['-xzf', calls[0]?.args[3] ?? '', '-C', TEST_CLIENT_RUNTIME],
    })
    expect(calls[2]).toEqual({
      command: 'curl',
      args: ['-fsSL', KB_SERVER_RELEASE_TARBALL_URL, '-o', calls[2]?.args[3] ?? ''],
    })
    expect(calls[3]).toEqual({
      command: 'tar',
      args: ['-xzf', calls[2]?.args[3] ?? '', '-C', TEST_SERVER_RUNTIME],
    })

    expect((await lstat(TEST_KB_BIN_LINK)).isSymbolicLink()).toBe(true)
    expect(await readlink(TEST_KB_BIN_LINK)).toBe(TEST_KB_PACKAGE_BIN)
    expect((await lstat(TEST_SERVER_BIN_LINK)).isSymbolicLink()).toBe(true)
    expect(await readlink(TEST_SERVER_BIN_LINK)).toBe(TEST_SERVER_PACKAGE_BIN)

    delete process.env.KB_INSTALL_ROOT
    await rm(TEST_KB_HOME, { recursive: true, force: true })
  })

  it('[TC-419] Given legacy no-build flag, then sync rejects it', async () => {
    await expect(runSyncCommand(['--no-build'])).rejects.toThrow('Unknown sync flag: --no-build')
  })

  it('[TC-420] Given positional args, then sync rejects them', async () => {
    await expect(runSyncCommand(['extra'])).rejects.toThrow(
      'kb sync does not accept positional arguments.'
    )
  })
})
