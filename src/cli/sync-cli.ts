import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getKbHomeDir } from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'

const CANONICAL_REPO_URL = 'https://github.com/rosenjcb/kb.git'
const MIN_NODE_MAJOR = 20

export interface SyncCommandOptions {
  cwd?: string
  mode?: CmdMode
  sourceDir?: string
  runCommand?: (command: string, args: string[], cwd: string) => Promise<string>
}

interface ParsedSyncCommand {
  noPull: boolean
  noBuild: boolean
  noLink: boolean
}

interface PackageManagerPlan {
  installCommand: { command: string; args: string[]; display: string }
  buildCommand: { command: string; args: string[]; display: string }
}

export function printSyncHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('sync', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('sync', mode)} [--no-pull] [--no-build] [--no-link]`,
    '',
    'Behavior:',
    '  Uses a managed local clone of `https://github.com/rosenjcb/kb.git`, not the current directory.',
    '  Clones that repo into `~/.kb/sources/kb` on first run, then fast-forwards `main`, installs deps, rebuilds, and refreshes the global `kb` link.',
    `  Requires Node ${MIN_NODE_MAJOR}+ in the shell that runs ${cmd('sync', mode)}.`,
    '',
    'Flags:',
    '  --no-pull   Skip clone/fetch/pull and only rebuild/relink the managed source',
    '  --no-build  Skip `npm run build`',
    '  --no-link   Skip `npm link` after the build',
    '',
    'Examples:',
    `  ${cmd('sync', mode)}`,
    `  ${cmd('sync --no-pull', mode)}`,
    `  ${cmd('sync --no-link', mode)}`,
  ].join('\n')
}

export async function runSyncCommand(
  args: string[],
  options: SyncCommandOptions = {}
): Promise<string> {
  const mode = options.mode ?? 'cli'
  const parsed = parseSyncCommand(args, mode)
  const run = options.runCommand ?? runShellCommand
  const callerCwd = path.resolve(options.cwd ?? process.cwd())
  const repoDir = path.resolve(options.sourceDir ?? path.join(getKbHomeDir(), 'sources', 'kb'))

  assertSupportedNodeVersion()

  const steps: string[] = [`Managed source: ${repoDir}`, `Remote: ${CANONICAL_REPO_URL}`]

  if (!parsed.noPull) {
    const prepared = await ensureManagedRepo(repoDir, callerCwd, run)
    if (prepared.cloned) {
      steps.push(formatStep(`git clone ${CANONICAL_REPO_URL} ${repoDir}`, prepared.cloneOutput))
    }

    const originUrl = await run('git', ['remote', 'get-url', 'origin'], repoDir)
    if (!isCanonicalOriginUrl(originUrl)) {
      throw new Error(
        `Managed source has unexpected origin "${originUrl}". Expected ${CANONICAL_REPO_URL}.`
      )
    }

    const branch = await run('git', ['branch', '--show-current'], repoDir)
    if (branch !== 'main') {
      throw new Error(
        `Managed source is on branch "${branch}". Fix ${repoDir} or re-clone it from ${CANONICAL_REPO_URL}.`
      )
    }

    const status = await run('git', ['status', '--porcelain'], repoDir)
    if (status.trim().length > 0) {
      throw new Error(
        `Managed source has local changes in ${repoDir}. Commit, stash, or delete that clone before running ${cmd('sync', mode)} again.`
      )
    }

    const fetchOutput = await run('git', ['fetch', 'origin', 'main'], repoDir)
    steps.push(formatStep('git fetch origin main', fetchOutput))

    const pullOutput = await run('git', ['pull', '--ff-only', 'origin', 'main'], repoDir)
    steps.push(formatStep('git pull --ff-only origin main', pullOutput))
  } else {
    const exists = await pathExists(repoDir)
    if (!exists) {
      throw new Error(
        `Managed source is missing at ${repoDir}. Run ${cmd('sync', mode)} once without --no-pull first.`
      )
    }
    steps.push('Skipped: clone/fetch/pull')
  }

  const packageManager = await resolvePackageManagerPlan(repoDir)

  if (!parsed.noBuild) {
    const installOutput = await run(
      packageManager.installCommand.command,
      packageManager.installCommand.args,
      repoDir
    )
    steps.push(formatStep(packageManager.installCommand.display, installOutput))

    const buildOutput = await run(
      packageManager.buildCommand.command,
      packageManager.buildCommand.args,
      repoDir
    )
    steps.push(formatStep(packageManager.buildCommand.display, buildOutput))
  } else {
    steps.push(`Skipped: ${packageManager.installCommand.display}`)
    steps.push(`Skipped: ${packageManager.buildCommand.display}`)
  }

  if (!parsed.noLink) {
    const linkOutput = await run('npm', ['link'], repoDir)
    steps.push(formatStep('npm link', linkOutput))
  } else {
    steps.push('Skipped: npm link')
  }

  steps.push('Sync complete.')
  return steps.join('\n\n')
}

function parseSyncCommand(args: string[], mode: CmdMode): ParsedSyncCommand {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new Error(printSyncHelp(mode))
  }

  const allowed = new Set(['--no-pull', '--no-build', '--no-link'])
  const unknown = args.find(arg => arg.startsWith('--') && !allowed.has(arg))
  if (unknown) {
    throw new Error(`Unknown sync flag: ${unknown}\n\n${printSyncHelp(mode)}`)
  }

  const positional = args.find(arg => !arg.startsWith('--'))
  if (positional) {
    throw new Error(
      `${cmd('sync', mode)} does not accept positional arguments.\n\n${printSyncHelp(mode)}`
    )
  }

  return {
    noPull: args.includes('--no-pull'),
    noBuild: args.includes('--no-build'),
    noLink: args.includes('--no-link'),
  }
}

async function resolvePackageManagerPlan(repoDir: string): Promise<PackageManagerPlan> {
  if (await pathExists(path.join(repoDir, 'pnpm-lock.yaml'))) {
    return {
      installCommand: {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile'],
        display: 'pnpm install --frozen-lockfile',
      },
      buildCommand: {
        command: 'pnpm',
        args: ['build'],
        display: 'pnpm build',
      },
    }
  }

  return {
    installCommand: {
      command: 'npm',
      args: ['install'],
      display: 'npm install',
    },
    buildCommand: {
      command: 'npm',
      args: ['run', 'build'],
      display: 'npm run build',
    },
  }
}

async function ensureManagedRepo(
  repoDir: string,
  cwd: string,
  runCommand: (command: string, args: string[], cwd: string) => Promise<string>
): Promise<{ cloned: boolean; cloneOutput?: string }> {
  if (await pathExists(repoDir)) {
    return { cloned: false }
  }

  await mkdir(path.dirname(repoDir), { recursive: true })
  const cloneOutput = await runCommand('git', ['clone', CANONICAL_REPO_URL, repoDir], cwd)
  return { cloned: true, cloneOutput }
}

function isCanonicalOriginUrl(originUrl: string): boolean {
  const normalized = originUrl.trim().toLowerCase()
  return (
    normalized === CANONICAL_REPO_URL ||
    normalized === 'git@github.com:rosenjcb/kb.git' ||
    normalized === 'https://github.com/rosenjcb/kb'
  )
}

function assertSupportedNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `kb sync requires Node ${MIN_NODE_MAJOR}+; current runtime is ${process.versions.node}. Switch to a newer Node before syncing.`
    )
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runShellCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim() || stderr.trim())
        return
      }
      reject(new Error((stderr || stdout || `${command} exited with code ${String(code)}`).trim()))
    })
  })
}

function formatStep(command: string, output: string | undefined): string {
  return output ? `$ ${command}\n${output}` : `$ ${command}`
}
