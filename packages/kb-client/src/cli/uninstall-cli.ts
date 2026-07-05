import { createInterface } from 'node:readline'
import {
  performClientUninstall,
  type UninstallLogger,
} from '@kb/core/cli/release-uninstall.js'
import type { CliOutput } from './index.js'

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function asLogger(out: CliOutput): UninstallLogger {
  return {
    log: msg => out.log(msg),
    error: msg => out.error(msg),
  }
}

/**
 * Remove the release-installed kb **client** only.
 * Server binary, runtime, and ~/.kb data are left intact.
 */
export async function runUninstallCommand(args: string[], out: CliOutput): Promise<void> {
  const yes = args.includes('--yes') || args.includes('-y')
  const purge = args.includes('--purge')

  if (purge) {
    out.error(
      'kb uninstall removes the client only — there is no client-side data to purge.\n' +
        'To delete server indexes, sessions, and logs, run: kb-server uninstall --purge'
    )
    process.exitCode = 1
    return
  }

  const unknown = args.find(arg => arg.startsWith('--') && arg !== '--yes' && arg !== '-y')
  if (unknown) {
    out.error(`Unknown uninstall flag: ${unknown}`)
    process.exitCode = 1
    return
  }

  if (!yes && !process.stdin.isTTY) {
    out.error('kb uninstall requires an interactive terminal. Pass --yes to skip prompts.')
    process.exitCode = 1
    return
  }

  out.log('KB client uninstall')
  out.log('')
  out.log('This removes the kb CLI/TUI client only:')
  out.log('  • ~/.kb/bin/kb symlink')
  out.log('  • ~/.kb/runtime/client (and legacy client runtime if present)')
  out.log('  • ~/.kb/.kb-python (legacy)')
  out.log('')
  out.log('Does NOT remove:')
  out.log('  • kb-server (use kb-server uninstall)')
  out.log('  • Knowledge bases, config, or logs under ~/.kb (use kb-server uninstall --purge)')
  out.log('')

  if (!yes) {
    const answer = await prompt('Uninstall the kb client? [y/N]: ')
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      out.log('Cancelled.')
      return
    }
  }

  await performClientUninstall(asLogger(out))
  out.log('')
  out.log('Done. kb client uninstalled. kb-server and ~/.kb data were not modified.')
}
