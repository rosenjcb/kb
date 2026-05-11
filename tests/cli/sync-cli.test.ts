import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '../../src/cli/sync-cli'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz'
const PNPM_GLOBAL_ROOT = '/Users/test/Library/pnpm/global/5/node_modules'
const PNPM_IMPORTER_DIR = path.dirname(PNPM_GLOBAL_ROOT)
const PNPM_BIN_DIR = path.dirname(path.dirname(path.dirname(PNPM_GLOBAL_ROOT)))

describe('sync-cli', () => {
  it('Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain('Node 22+')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('Given no flags, then sync installs the latest release tarball into pnpm global home', async () => {
    const calls: string[] = []
    const runCommand = vi.fn(
      async (
        command: string,
        args: string[],
        _cwd: string
      ) => {
        const joined = `${command} ${args.join(' ')}`
        calls.push(joined)
        if (joined === 'pnpm root -g') {
          return PNPM_GLOBAL_ROOT
        }
        if (joined === `pnpm add -g ${RELEASE_TARBALL_URL}`) {
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
    expect(progressLines.some(l => l.includes(PNPM_BIN_DIR))).toBe(true)
    expect(progressLines.some(l => l.includes('Rebuilding native dependency'))).toBe(true)
    expect(output).toContain('Sync complete.')
    expect(output).toContain('install ok')
    expect(output).toContain('rebuild ok')
    expect(calls).toEqual([
      'pnpm root -g',
      `pnpm add -g ${RELEASE_TARBALL_URL}`,
      `pnpm rebuild better-sqlite3 --dir ${PNPM_IMPORTER_DIR}`,
    ])
    expect(runCommand).toHaveBeenCalledTimes(3)
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
