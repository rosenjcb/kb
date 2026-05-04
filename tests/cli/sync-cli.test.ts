import { describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '../../src/cli/sync-cli'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz'

describe('sync-cli', () => {
  it('Given --help, then prints release-based sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('GitHub Releases')
    expect(printSyncHelp()).toContain(RELEASE_TARBALL_URL)
    expect(printSyncHelp()).toContain('Node 22+')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('Given no flags, then sync installs the latest release tarball globally', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`
      if (joined === `npm install -g ${RELEASE_TARBALL_URL}`) {
        return 'install ok'
      }
      throw new Error(`Unexpected command: ${joined}`)
    })

    const output = await runSyncCommand([], { cwd: '/tmp/kb-sync-test', runCommand })

    expect(output).toContain(`Release asset: ${RELEASE_TARBALL_URL}`)
    expect(output).toContain('install ok')
    expect(runCommand).toHaveBeenCalledTimes(1)
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
