import { spawn } from 'node:child_process'
import { type CmdMode, cmd } from './cmd-ref'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz'
const MIN_NODE_MAJOR = 22

export interface SyncCommandOptions {
  cwd?: string
  mode?: CmdMode
  onProgress?: (line: string) => void
  runCommand?: (command: string, args: string[], cwd: string, onProgress?: (line: string) => void) => Promise<string>
}

export function printSyncHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('sync', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('sync', mode)}`,
    '',
    'Behavior:',
    '  Installs the latest published KB CLI release from GitHub Releases.',
    `  Release asset: ${RELEASE_TARBALL_URL}`,
    `  Requires Node ${MIN_NODE_MAJOR}+ in the shell that runs ${cmd('sync', mode)}.`,
    '',
    'Examples:',
    `  ${cmd('sync', mode)}`,
  ].join('\n')
}

export async function runSyncCommand(
  args: string[],
  options: SyncCommandOptions = {}
): Promise<string> {
  const mode = options.mode ?? 'cli'
  parseSyncCommand(args, mode)
  assertSupportedNodeVersion()

  const cwd = options.cwd ?? process.cwd()
  const run = options.runCommand ?? runShellCommand
  const { onProgress } = options

  onProgress?.('Downloading and installing from GitHub Releases (this may take ~1 minute)...')
  onProgress?.(`Release asset: ${RELEASE_TARBALL_URL}`)

  const installOutput = await run('npm', ['install', '-g', RELEASE_TARBALL_URL], cwd, onProgress)

  return `Sync complete.\n${installOutput.trim()}`
}

function parseSyncCommand(args: string[], mode: CmdMode): void {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new Error(printSyncHelp(mode))
  }

  const unknown = args.find(arg => arg.startsWith('--'))
  if (unknown) {
    throw new Error(`Unknown sync flag: ${unknown}\n\n${printSyncHelp(mode)}`)
  }

  const positional = args.find(arg => !arg.startsWith('--'))
  if (positional) {
    throw new Error(
      `${cmd('sync', mode)} does not accept positional arguments.\n\n${printSyncHelp(mode)}`
    )
  }
}

function assertSupportedNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `kb sync requires Node ${MIN_NODE_MAJOR}+; current runtime is ${process.versions.node}. Switch to a newer Node before syncing.`
    )
  }
}

async function runShellCommand(
  command: string,
  args: string[],
  cwd: string,
  onProgress?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    // npm buffers all output when stdout is not a TTY, so data events only fire at the end.
    // Emit elapsed-time heartbeats so the caller knows the process is alive.
    let elapsed = 0
    const heartbeat = onProgress
      ? setInterval(() => {
          elapsed += 5
          onProgress(`  still installing… (${elapsed}s)`)
        }, 5000)
      : null

    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    function finish(code: number | null) {
      if (heartbeat) clearInterval(heartbeat)
      if (code === 0) {
        resolve(stdout.trim() || stderr.trim())
        return
      }
      reject(new Error((stderr || stdout || `${command} exited with code ${String(code)}`).trim()))
    }

    child.on('error', err => {
      if (heartbeat) clearInterval(heartbeat)
      reject(err)
    })
    child.on('close', finish)
  })
}
