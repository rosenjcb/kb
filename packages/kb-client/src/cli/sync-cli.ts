import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'

const RELEASE_TARBALL_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node24.tgz'
const RELEASE_INSTALLER_URL =
  'https://github.com/rosenjcb/kb/releases/latest/download/install-kb.sh'

/**
 * KB pins exactly Node 24.x (`.nvmrc`, `engines.node`, the launcher, and the
 * released `kb-cli-node24.tgz` asset all agree). Everything kb does must run on
 * this managed runtime — never the user's ambient Node/npm.
 */
const PINNED_NODE_MAJOR = 24

/** A Node binary plus the `npm-cli.js` it ships with, used to drive the install. */
export interface NodeRuntime {
  nodeBin: string
  npmCli: string
}

function resolveKbInstallPaths(): {
  kbHomeDir: string
  runtimeDir: string
  binDir: string
  binLink: string
  packageBin: string
} {
  const kbHomeDir = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
  const runtimeDir = path.join(kbHomeDir, 'runtime')
  const binDir = path.join(kbHomeDir, 'bin')
  const binLink = path.join(binDir, 'kb')
  const packageBin = path.join(runtimeDir, 'node_modules', '.bin', 'kb')
  return { kbHomeDir, runtimeDir, binDir, binLink, packageBin }
}

export interface SyncCommandOptions {
  cwd?: string
  mode?: CmdMode
  onProgress?: (line: string) => void
  /** Override the managed-runtime lookup (tests inject a deterministic runtime). */
  resolveNodeRuntime?: () => NodeRuntime
  runCommand?: (
    command: string,
    args: string[],
    cwd: string,
    onProgress?: (line: string) => void,
    env?: NodeJS.ProcessEnv
  ) => Promise<string>
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
    `  Fresh-machine installer: curl -fsSL ${RELEASE_INSTALLER_URL} | bash`,
    `  Runs on KB's managed Node ${PINNED_NODE_MAJOR} runtime — your shell's Node version does not matter.`,
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

  const cwd = options.cwd ?? process.cwd()
  const run = options.runCommand ?? runShellCommand
  const resolveRuntime = options.resolveNodeRuntime ?? findManagedNodeRuntime
  const { onProgress } = options
  const paths = resolveKbInstallPaths()

  // Use KB's managed Node 24 + its bundled npm for the install, regardless of
  // whatever Node/npm happens to be on the user's PATH.
  const runtime = resolveRuntime()

  await mkdir(paths.runtimeDir, { recursive: true })
  await mkdir(paths.binDir, { recursive: true })

  onProgress?.('Downloading and installing from GitHub Releases (this may take ~1 minute)...')
  onProgress?.(`Release asset: ${RELEASE_TARBALL_URL}`)
  onProgress?.(`Managed Node runtime: ${runtime.nodeBin}`)
  onProgress?.(`Managed install root: ${paths.runtimeDir}`)
  onProgress?.(`Stable binary path: ${paths.binLink}`)

  // `--ignore-scripts` matches the fresh-install path (install-release.sh): all
  // grammars ship as prebuilt WASM, so there is nothing to compile.
  const nodeBinDir = path.dirname(runtime.nodeBin)
  const installOutput = await run(
    runtime.nodeBin,
    [runtime.npmCli, 'install', '--ignore-scripts', '--prefix', paths.runtimeDir, RELEASE_TARBALL_URL],
    cwd,
    onProgress,
    { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}` }
  )

  await rm(paths.binLink, { force: true })
  await symlink(paths.packageBin, paths.binLink)

  const details = [
    installOutput.trim(),
    `Installed to ${paths.runtimeDir}`,
    `Linked ${paths.binLink} -> ${paths.packageBin}`,
  ]
    .filter(Boolean)
    .join('\n')
  return `Sync complete.\n${details}`
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

/** `npm-cli.js` location relative to a Node binary (`<prefix>/bin/node`). */
function npmCliForNode(nodeBin: string): string {
  return path.resolve(path.dirname(nodeBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function currentNodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
}

/**
 * Locate KB's managed Node 24 runtime and the npm it ships with. Preference:
 *   1. An nvm-managed Node 24.x (what the bootstrap installer provisions).
 *   2. The Node already running kb, if it is Node 24.x.
 * Throws with installer guidance when no Node 24 runtime can be found, so sync
 * never silently falls back to an incompatible Node.
 */
export function findManagedNodeRuntime(): NodeRuntime {
  const candidates: string[] = []

  const nvmDir = process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm')
  const versionsDir = path.join(nvmDir, 'versions', 'node')
  try {
    const matching = readdirSync(versionsDir)
      .filter(name => name.startsWith(`v${PINNED_NODE_MAJOR}.`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const dir of matching) candidates.push(path.join(versionsDir, dir, 'bin', 'node'))
  } catch {
    // nvm not present — fall through to the running Node.
  }

  if (currentNodeMajor() === PINNED_NODE_MAJOR) candidates.push(process.execPath)

  for (const nodeBin of candidates) {
    if (!existsSync(nodeBin)) continue
    const npmCli = npmCliForNode(nodeBin)
    if (existsSync(npmCli)) return { nodeBin, npmCli }
  }

  throw new Error(
    `kb sync could not find KB's managed Node ${PINNED_NODE_MAJOR} runtime. ` +
      `Reinstall it with the bootstrap installer: curl -fsSL ${RELEASE_INSTALLER_URL} | bash`
  )
}

async function runShellCommand(
  command: string,
  args: string[],
  cwd: string,
  onProgress?: (line: string) => void,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    })

    let stdout = ''
    let stderr = ''

    // Package managers can buffer output when stdout is not a TTY, so data events may only
    // fire at the end.
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
