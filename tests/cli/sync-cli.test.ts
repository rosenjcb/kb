import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { printSyncHelp, runSyncCommand } from '../../src/cli/sync-cli'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('sync-cli', () => {
  it('Given --help, then prints sync help', () => {
    expect(printSyncHelp()).toContain('kb sync command')
    expect(printSyncHelp()).toContain('~/.kb/sources/kb')
    expect(printSyncHelp()).toContain('Node 22+')
    expect(printSyncHelp()).toContain('installs deps')
    expect(printSyncHelp('tui')).toContain('/sync command')
  })

  it('Given missing managed repo, then sync clones canonical source, installs deps, builds, and links', async () => {
    const callerDir = await createTempDir('kb-sync-caller-')
    const sourceDir = path.join(await createTempDir('kb-sync-home-'), 'sources', 'kb')
    const runCommand = vi.fn(async (command: string, args: string[], cwd: string) => {
      const joined = `${command} ${args.join(' ')}`
      switch (joined) {
        case `git clone https://github.com/rosenjcb/kb.git ${sourceDir}`:
          await mkdir(sourceDir, { recursive: true })
          await writeFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
          return 'clone ok'
        case 'git remote get-url origin':
          return 'https://github.com/rosenjcb/kb.git'
        case 'git branch --show-current':
          return 'main'
        case 'git status --porcelain':
          return ''
        case 'git fetch origin main':
          return 'fetch ok'
        case 'git pull --ff-only origin main':
          return 'Already up to date.'
        case 'pnpm install --frozen-lockfile':
          return 'install ok'
        case 'pnpm build':
          return 'build ok'
        case 'npm link':
          return 'link ok'
        default:
          throw new Error(`Unexpected command: ${joined} @ ${cwd}`)
      }
    })

    const output = await runSyncCommand([], { cwd: callerDir, sourceDir, runCommand })

    expect(output).toContain(`Managed source: ${sourceDir}`)
    expect(output).toContain('clone ok')
    expect(output).toContain('fetch ok')
    expect(output).toContain('Already up to date.')
    expect(output).toContain('install ok')
    expect(output).toContain('build ok')
    expect(output).toContain('link ok')
  })

  it('Given an existing managed repo with a non-canonical origin, then sync rejects it', async () => {
    const callerDir = await createTempDir('kb-sync-caller-')
    const sourceRoot = await createTempDir('kb-sync-home-')
    const sourceDir = path.join(sourceRoot, 'sources', 'kb')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

    const runCommand = vi.fn(async (command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`
      if (joined === 'git remote get-url origin') return 'https://github.com/other/fork.git'
      throw new Error(`Unexpected command: ${joined}`)
    })

    await expect(runSyncCommand([], { cwd: callerDir, sourceDir, runCommand })).rejects.toThrow(
      'Managed source has unexpected origin'
    )
  })

  it('Given a dirty managed repo, then sync refuses to pull', async () => {
    const callerDir = await createTempDir('kb-sync-caller-')
    const sourceRoot = await createTempDir('kb-sync-home-')
    const sourceDir = path.join(sourceRoot, 'sources', 'kb')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

    const runCommand = vi.fn(async (command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`
      switch (joined) {
        case 'git remote get-url origin':
          return 'https://github.com/rosenjcb/kb.git'
        case 'git branch --show-current':
          return 'main'
        case 'git status --porcelain':
          return ' M package.json'
        default:
          throw new Error(`Unexpected command: ${joined}`)
      }
    })

    await expect(runSyncCommand([], { cwd: callerDir, sourceDir, runCommand })).rejects.toThrow(
      'Managed source has local changes'
    )
  })

  it('Given --no-pull and an existing managed repo, then sync skips network work and still installs/builds', async () => {
    const callerDir = await createTempDir('kb-sync-caller-')
    const sourceRoot = await createTempDir('kb-sync-home-')
    const sourceDir = path.join(sourceRoot, 'sources', 'kb')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

    const runCommand = vi.fn(async (command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`
      switch (joined) {
        case 'pnpm install --frozen-lockfile':
          return 'install ok'
        case 'pnpm build':
          return 'build ok'
        case 'npm link':
          return 'link ok'
        default:
          throw new Error(`Unexpected command: ${joined}`)
      }
    })

    const output = await runSyncCommand(['--no-pull'], { cwd: callerDir, sourceDir, runCommand })
    expect(output).toContain('Skipped: clone/fetch/pull')
    expect(output).toContain('install ok')
    expect(output).toContain('build ok')
    expect(runCommand).toHaveBeenCalledTimes(3)
  })
})
