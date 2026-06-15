import { type CmdMode, cmd } from './cmd-ref'
import {
  type KbConfig,
  getConfigValue,
  getKbConfigFile,
  listSupportedConfigPaths,
  readKbConfig,
  setConfigValue,
  unsetConfigValue,
  writeKbConfig,
} from './kb-config'
import { runLLMSetupWizard, showLLMStatus } from './llm-setup-wizard'
import { isRepoAction, runRepoCommand } from './repo-cli'

export interface ConfigCommandResult {
  output: string
}

export interface RunConfigCommandOptions {
  configFile?: string
  isTTY?: boolean
  mode?: CmdMode
}

type ConfigCommand =
  | { action: 'get'; keyPath?: string }
  | { action: 'set'; keyPath: string; value: string }
  | { action: 'unset'; keyPath: string }
  | { action: 'llm' }

export function printConfigHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('config', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('config get', mode)}`,
    `  ${cmd('config get <key>', mode)}`,
    `  ${cmd('config set <key> <value>', mode)}`,
    `  ${cmd('config unset <key>', mode)}`,
    `  ${cmd('config llm', mode)}              Set up LLM provider (interactive wizard)`,
    `  ${cmd('config llm --show', mode)}       Show current LLM configuration`,
    '',
    'Git repos (per base):',
    `  ${cmd('config list-repos [--base <name>]', mode)}            List the repos a base tracks`,
    `  ${cmd('config add-repo <url[#branch]> [--branch <b>] [--base <name>]', mode)}   Clone + index another repo`,
    `  ${cmd('config remove-repo <url|slug> [--base <name>]', mode)}    Remove a repo and its facts`,
    '',
    `Supported keys: ${listSupportedConfigPaths().join(', ')}`,
  ].join('\n')
}

export async function runConfigCommand(
  args: string[],
  options: RunConfigCommandOptions = {}
): Promise<ConfigCommandResult> {
  const mode = options.mode ?? 'cli'

  // Per-base git repo management lives under `kb config` but operates on the base's meta.json.
  const action = args[0]
  if (isRepoAction(action)) {
    const result = await runRepoCommand(action, args.slice(1), { mode })
    return { output: result.output }
  }

  const command = parseConfigCommand(args, mode)
  const configFile = options.configFile ?? getKbConfigFile()

  if (command.action === 'llm') {
    const lines: string[] = []
    const print = (msg: string) => lines.push(msg)

    if (args[1] === '--show') {
      await showLLMStatus({ configFile, output: print })
    } else {
      const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY)
      if (!isTTY || mode === 'tui') {
        await showLLMStatus({ configFile, output: print })
        lines.push(
          mode === 'tui'
            ? 'LLM wizard requires interactive CLI. Run `kb config llm` in a terminal.'
            : `Run \`${cmd('config llm', mode)}\` in an interactive terminal to configure.`
        )
      } else {
        await runLLMSetupWizard({ configFile, output: print })
      }
    }

    return { output: lines.join('\n') }
  }

  const config = await readKbConfig(configFile)

  switch (command.action) {
    case 'get':
      return {
        output: formatConfigValue(getConfigValue(config, command.keyPath), command.keyPath),
      }
    case 'set': {
      const next = setConfigValue(config, command.keyPath, command.value)
      const saved = await writeKbConfig(next, configFile)
      return {
        output: formatConfigWriteResult('Set', command.keyPath, saved),
      }
    }
    case 'unset': {
      const next = unsetConfigValue(config, command.keyPath)
      const saved = await writeKbConfig(next, configFile)
      return {
        output: formatConfigWriteResult('Unset', command.keyPath, saved),
      }
    }
  }
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

  if (action === 'set') {
    if (args.length < 3) {
      throw new Error(`${cmd('config set', mode)} requires <key> <value>`)
    }
    return { action: 'set', keyPath: args[1], value: args.slice(2).join(' ') }
  }

  if (action === 'unset') {
    if (args.length !== 2) {
      throw new Error(`${cmd('config unset', mode)} requires <key>`)
    }
    return { action: 'unset', keyPath: args[1] }
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

function formatConfigWriteResult(verb: 'Set' | 'Unset', keyPath: string, config: KbConfig): string {
  return [`${verb} ${keyPath}`, `${JSON.stringify(config, null, 2)}`].join('\n')
}
