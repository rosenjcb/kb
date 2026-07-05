import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import {
  getConfigValue,
  listSupportedConfigPaths,
  readKbConfig,
} from '@kb/core/config/kb-config.js'
import { runLLMSetupWizard, showLLMStatus } from './llm-setup-wizard'

export interface ConfigCommandResult {
  output: string
}

export interface RunConfigCommandOptions {
  isTTY?: boolean
  mode?: CmdMode
}

type ConfigCommand =
  | { action: 'get'; keyPath?: string }
  | { action: 'llm' }

export function printConfigHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('config', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('config get', mode)}`,
    `  ${cmd('config get <key>', mode)}`,
    `  ${cmd('config llm', mode)}              Set up LLM provider (interactive wizard)`,
    `  ${cmd('config llm --show', mode)}       Show current LLM configuration`,
    '',
    'Configuration is environment-only. Set KB_* variables in your shell profile.',
    '',
    `Manage a base's git repos with ${cmd('base repo add', mode)} / ${cmd('base repo remove', mode)} / ${cmd('base repo list', mode)}.`,
    '',
    `Readable keys: ${listSupportedConfigPaths().join(', ')}`,
  ].join('\n')
}

export async function runConfigCommand(
  args: string[],
  options: RunConfigCommandOptions = {}
): Promise<ConfigCommandResult> {
  const mode = options.mode ?? 'cli'
  const command = parseConfigCommand(args, mode)

  if (command.action === 'llm') {
    const lines: string[] = []
    const print = (msg: string) => lines.push(msg)

    if (args[1] === '--show') {
      await showLLMStatus({ output: print })
    } else {
      const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY)
      if (!isTTY || mode === 'tui') {
        await showLLMStatus({ output: print })
        lines.push(
          mode === 'tui'
            ? 'LLM wizard requires interactive CLI. Run `kb config llm` in a terminal.'
            : `Run \`${cmd('config llm', mode)}\` in an interactive terminal to configure.`
        )
      } else {
        await runLLMSetupWizard({ output: print })
      }
    }

    return { output: lines.join('\n') }
  }

  const config = await readKbConfig()

  if (command.action === 'get') {
    return {
      output: formatConfigValue(getConfigValue(config, command.keyPath), command.keyPath),
    }
  }

  throw new Error(`Unknown config action\n\n${printConfigHelp(mode)}`)
}

function parseConfigCommand(args: string[], mode: CmdMode = 'cli'): ConfigCommand {
  const action = args[0]

  if (!action || action === '--help' || action === '-h' || action === 'help') {
    throw new Error(printConfigHelp(mode))
  }

  if (action === 'llm') {
    return { action: 'llm' }
  }

  if (action === 'get') {
    if (args.length > 2) {
      throw new Error(`${cmd('config get', mode)} accepts at most one key`)
    }
    return { action: 'get', keyPath: args[1] }
  }

  if (action === 'set' || action === 'unset') {
    throw new Error(
      `${cmd(`config ${action}`, mode)} is not supported. Configuration is environment-only — use KB_* variables in your shell profile.\n\n${printConfigHelp(mode)}`
    )
  }

  throw new Error(`Unknown config action: ${action}\n\n${printConfigHelp(mode)}`)
}

function formatConfigValue(value: unknown, keyPath?: string): string {
  if (!keyPath) {
    return `${JSON.stringify(value, null, 2)}\n`
  }

  if (typeof value === 'string') {
    return `${value}\n`
  }

  return `${JSON.stringify(value, null, 2)}\n`
}
