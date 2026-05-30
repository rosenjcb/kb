import { access, readFile, rm, unlink, writeFile } from 'node:fs/promises'
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

export async function runUninstallCommand(out: CliOutput): Promise<void> {
  if (!process.stdin.isTTY) {
    out.error('kb uninstall requires an interactive terminal.')
    process.exitCode = 1
    return
  }

  const kbHome = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
  const kbBinDir = path.join(kbHome, 'bin')
  const kbBinLink = path.join(kbBinDir, 'kb')
  const kbRuntimeDir = path.join(kbHome, 'runtime')

  out.log('KB Uninstall')
  out.log('')
  out.log('This will remove:')
  out.log(`  • Binary symlink:    ${kbBinLink}`)
  out.log(`  • Installed runtime: ${kbRuntimeDir}`)
  out.log('  • PATH entry from shell config')
  out.log(`  Knowledge bases in ${kbHome} will be preserved unless you opt in below.`)
  out.log('')

  if (await exists(kbBinLink)) {
    await unlink(kbBinLink)
    out.log(`Removed: ${kbBinLink}`)
  }

  if (await exists(kbRuntimeDir)) {
    await rm(kbRuntimeDir, { recursive: true, force: true })
    out.log(`Removed: ${kbRuntimeDir}`)
  }

  const rcModified = await removePathFromRcFiles(kbBinDir)
  for (const rc of rcModified) {
    out.log(`Removed PATH entry from: ${rc}`)
  }

  out.log('')

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

  out.log('')
  out.log('Done. KB has been uninstalled.')
}
