import { createInterface } from 'node:readline'
import { performServerUninstall, type UninstallLogger } from '@kb/core/cli/release-uninstall.js'

export interface ServerLogger {
  log(message: string): void
  error(message: string): void
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

function asLogger(out: ServerLogger): UninstallLogger {
  return {
    log: msg => out.log(msg),
    error: msg => out.error(msg),
  }
}

export async function runServerUninstallCommand(args: string[], out: ServerLogger): Promise<void> {
  const yes = args.includes('--yes') || args.includes('-y')
  const purge = args.includes('--purge')

  const unknown = args.find(
    arg => arg.startsWith('--') && !['--yes', '-y', '--purge'].includes(arg)
  )
  if (unknown) {
    out.error(`Unknown uninstall flag: ${unknown}`)
    process.exitCode = 1
    return
  }

  if (!yes && !process.stdin.isTTY) {
    out.error('kb-server uninstall requires an interactive terminal. Pass --yes to skip prompts.')
    process.exitCode = 1
    return
  }

  out.log('KB server uninstall')
  out.log('')
  out.log('This removes:')
  out.log('  • ~/.kb/bin/kb-server symlink')
  out.log('  • ~/.kb/runtime/server')
  if (purge) {
    out.log('  • Server data under ~/.kb: sessions, active-base, logs, traces')
    out.log('')
    out.log('Does NOT remove the kb client (~/.kb/bin/kb, runtime/client).')
  } else {
    out.log('')
    out.log('Knowledge bases and config under ~/.kb are kept.')
    out.log('To delete them too, re-run with --purge.')
  }
  out.log('')

  if (!yes) {
    const question = purge
      ? 'Uninstall kb-server and permanently delete all server data under ~/.kb? [y/N]: '
      : 'Uninstall kb-server? [y/N]: '
    const answer = await prompt(question)
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      out.log('Cancelled.')
      return
    }
  }

  await performServerUninstall({ purge }, asLogger(out))
  out.log('')
  out.log(
    purge
      ? 'Done. kb-server uninstalled and server data under ~/.kb removed.'
      : 'Done. kb-server uninstalled. Server data under ~/.kb was kept.'
  )
}
