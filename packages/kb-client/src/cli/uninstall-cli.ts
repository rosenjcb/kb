import { access, lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { CliOutput } from './index.js'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Like exists but doesn't follow symlinks — catches broken symlinks too. */
async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function removePathFromRcFiles(kbBinDir: string): Promise<string[]> {
  const rcFiles = [
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.profile'),
  ]
  const patterns = [
    `export PATH="${kbBinDir}:$PATH"`,
    'export PATH="$HOME/.kb/bin:$PATH"',
  ]
  const modified: string[] = []
  for (const rc of rcFiles) {
    if (!(await exists(rc))) continue
    const content = await readFile(rc, 'utf8')
    const lines = content.split('\n')
    const filtered = lines.filter(line => !patterns.includes(line.trim()))
    if (filtered.length !== lines.length) {
      await writeFile(rc, filtered.join('\n'), 'utf8')
      modified.push(rc)
    }
  }
  return modified
}

export interface UninstallOptions {
  /** Skip the interactive user-data prompt; keep ~/.kb intact. */
  yes: boolean
  /** Delete all user data at ~/.kb after removing the tool (implies yes). */
  purge: boolean
}

/**
 * Core uninstall logic shared by CLI and TUI.
 * Removes the binary symlink, Python venv, and installed runtime.
 * Does NOT delete ~/.kb user data unless opts.purge is true.
 */
export async function performUninstall(
  opts: UninstallOptions,
  out: CliOutput
): Promise<void> {
  const kbHome = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
  const kbBinDir = path.join(kbHome, 'bin')
  const kbBinLink = path.join(kbBinDir, 'kb')
  const kbServerBinLink = path.join(kbBinDir, 'kb-server')
  const kbRuntimeDir = path.join(kbHome, 'runtime')
  const kbPythonDir = path.join(kbHome, '.kb-python')

  if (await lexists(kbBinLink)) {
    await unlink(kbBinLink)
    out.log(`Removed: ${kbBinLink}`)
  }

  if (await lexists(kbServerBinLink)) {
    await unlink(kbServerBinLink)
    out.log(`Removed: ${kbServerBinLink}`)
  }

  if (await exists(kbRuntimeDir)) {
    await rm(kbRuntimeDir, { recursive: true, force: true })
    out.log(`Removed: ${kbRuntimeDir}`)
  }

  if (await exists(kbPythonDir)) {
    await rm(kbPythonDir, { recursive: true, force: true })
    out.log(`Removed: ${kbPythonDir}`)
  }

  const rcModified = await removePathFromRcFiles(kbBinDir)
  for (const rc of rcModified) {
    out.log(`Removed PATH entry from: ${rc}`)
  }

  if (opts.purge && (await exists(kbHome))) {
    await rm(kbHome, { recursive: true, force: true })
    out.log(`Removed: ${kbHome}`)
  }
}

export async function runUninstallCommand(args: string[], out: CliOutput): Promise<void> {
  const yes = args.includes('--yes') || args.includes('-y')
  const purge = args.includes('--purge')

  if (!yes && !purge && !process.stdin.isTTY) {
    out.error('kb uninstall requires an interactive terminal. Pass --yes to skip prompts.')
    process.exitCode = 1
    return
  }

  const kbHome = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
  const kbBinDir = path.join(kbHome, 'bin')
  const kbBinLink = path.join(kbBinDir, 'kb')
  const kbServerBinLink = path.join(kbBinDir, 'kb-server')
  const kbRuntimeDir = path.join(kbHome, 'runtime')
  const kbPythonDir = path.join(kbHome, '.kb-python')

  out.log('KB Uninstall')
  out.log('')
  out.log('This will remove:')
  out.log(`  • kb binary symlink:     ${kbBinLink}`)
  out.log(`  • kb-server symlink:     ${kbServerBinLink}`)
  out.log(`  • Installed runtimes:    ${kbRuntimeDir}`)
  out.log(`  • Python environment: ${kbPythonDir}`)
  out.log('  • PATH entry from shell config')
  if (!purge) {
    out.log(`  Knowledge bases in ${kbHome} will be preserved unless you opt in below.`)
  }
  out.log('')

  await performUninstall({ yes, purge }, out)

  out.log('')

  if (!purge && !yes) {
    if (await exists(kbHome)) {
      const answer = await prompt(
        `Delete all KB user data at ${kbHome}? (knowledge bases, config, logs) [y/N]: `
      )
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        await rm(kbHome, { recursive: true, force: true })
        out.log(`Removed: ${kbHome}`)
      } else {
        out.log(`Kept: ${kbHome}`)
      }
    }
  } else if (!purge && yes) {
    out.log(`Kept: ${kbHome}`)
  }

  out.log('')
  out.log('Done. KB has been uninstalled.')
}
