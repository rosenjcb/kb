import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '../../src/cli/sync-cli'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz'
const KB_BIN_DIR = path.join(homedir(), '.kb', 'bin')
const PNPM_GLOBAL_DIR = path.join(homedir(), '.kb', 'pnpm-global')
const PNPM_IMPORTER_DIR = path.join(PNPM_GLOBAL_DIR, '5')

describe('sync-cli', () => {
  it('Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain('Node 22+')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('Given no flags, then sync installs the latest release tarball into ~/.kb', async () => {
    const calls: string[] = []
    const runCommand = vi.fn(
      async (
        command: string,
        args: string[],
        _cwd: string,
        _onProgress?: (line: string) => void,
        env?: NodeJS.ProcessEnv
      ) => {
        const joined = `${command} ${args.join(' ')}`
        calls.push(joined)
        if (env?.PNPM_HOME !== KB_BIN_DIR) {
          throw new Error(`Unexpected PNPM_HOME: ${String(env?.PNPM_HOME)}`)
        }
        if (joined === `pnpm add -g --global-dir ${PNPM_GLOBAL_DIR} ${RELEASE_TARBALL_URL}`) {
          return 'install ok'
        }
        if (joined === `pnpm rebuild better-sqlite3 --dir ${PNPM_IMPORTER_DIR}`) {
          return 'rebuild ok'
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
    expect(progressLines.some(l => l.includes(KB_BIN_DIR))).toBe(true)
    expect(progressLines.some(l => l.includes('Rebuilding native dependency'))).toBe(true)
    expect(output).toContain('Sync complete.')
    expect(output).toContain('install ok')
    expect(output).toContain('rebuild ok')
    expect(calls).toEqual([
      `pnpm add -g --global-dir ${PNPM_GLOBAL_DIR} ${RELEASE_TARBALL_URL}`,
      `pnpm rebuild better-sqlite3 --dir ${PNPM_IMPORTER_DIR}`,
    ])
    expect(runCommand).toHaveBeenCalledTimes(2)
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
