import {
  type KbConfig,
  KB_CONFIG_FILE,
  getConfigValue,
  listSupportedConfigPaths,
  readKbConfig,
  setConfigValue,
  unsetConfigValue,
  writeKbConfig,
} from './kb-config'

export interface ConfigCommandResult {
  output: string
}

export interface RunConfigCommandOptions {
  configFile?: string
}

type ConfigCommand =
  | { action: 'get'; keyPath?: string }
  | { action: 'set'; keyPath: string; value: string }
  | { action: 'unset'; keyPath: string }

export function printConfigHelp(): string {
  return [
    'kb config commands',
    '',
    'Usage:',
    '  kb config get',
    '  kb config get <key>',
    '  kb config set <key> <value>',
    '  kb config unset <key>',
    '',
    `Supported keys: ${listSupportedConfigPaths().join(', ')}`,
  ].join('\n')
}

export async function runConfigCommand(
  args: string[],
  options: RunConfigCommandOptions = {},
): Promise<ConfigCommandResult> {
  const command = parseConfigCommand(args)
  const configFile = options.configFile ?? KB_CONFIG_FILE
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

function parseConfigCommand(args: string[]): ConfigCommand {
  const action = args[0]

  if (!action || action === '--help' || action === '-h' || action === 'help') {
    throw new Error(printConfigHelp())
  }

  if (action === 'get') {
    if (args.length > 2) {
      throw new Error('kb config get accepts at most one key')
    }
    return { action: 'get', keyPath: args[1] }
  }

  if (action === 'set') {
    if (args.length < 3) {
      throw new Error('kb config set requires <key> <value>')
    }
    return { action: 'set', keyPath: args[1], value: args.slice(2).join(' ') }
  }

  if (action === 'unset') {
    if (args.length !== 2) {
      throw new Error('kb config unset requires <key>')
    }
    return { action: 'unset', keyPath: args[1] }
  }

  throw new Error(`Unknown config action: ${action}\n\n${printConfigHelp()}`)
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
  return [
    `${verb} ${keyPath}`,
    `${JSON.stringify(config, null, 2)}`,
  ].join('\n')
}
