import type { SlashInputContext } from './slash-command-registry.js'
import {
  getSlashCommandsForContext,
  resolveSlashSuggestions,
  type SlashCommand,
} from './slash-command-registry.js'
import type { TuiMode } from './types.js'

export type { SlashCommand, SlashInputContext } from './slash-command-registry.js'
export { parseSlashInput, resolveSlashSuggestions, SLASH_COMMAND_REGISTRY } from './slash-command-registry.js'

export function getSlashCommands(_mode: TuiMode): SlashCommand[] {
  return getSlashCommandsForContext('idle')
}

export function getSlashCommandSuggestions(
  value: string,
  _mode: TuiMode,
  context: SlashInputContext = 'idle'
): SlashCommand[] {
  return resolveSlashSuggestions(value, context)
}

export function sanitizeSlashInput(value: string): string {
  return value.replace(/\t+/g, '')
}

export function clampSuggestionIndex(index: number, suggestions: SlashCommand[]): number {
  if (suggestions.length === 0) return -1
  if (index < 0) return suggestions.length - 1
  if (index >= suggestions.length) return 0
  return index
}

export function applySelectedSuggestion(suggestion?: SlashCommand, currentInput?: string): string {
  if (!suggestion) return ''

  const trimmed = currentInput?.trim() ?? ''
  if (trimmed && suggestion.command.toLowerCase().startsWith(trimmed.toLowerCase())) {
    return `${suggestion.command} `
  }

  return `${suggestion.command} `
}

export function normalizeSlashCommandArgs(args: string[]): string[] {
  if (args.length === 0) return args

  const [firstArg, ...rest] = args
  if (!firstArg?.startsWith('/')) return args

  const normalized = firstArg.slice(1)
  if (!normalized) return args

  return [normalized, ...rest]
}

export function getSuggestionWindow(
  suggestions: SlashCommand[],
  selectedIndex: number,
  maxVisible: number
): { visible: SlashCommand[]; startIndex: number } {
  if (suggestions.length === 0 || maxVisible <= 0) {
    return { visible: [], startIndex: 0 }
  }

  if (suggestions.length <= maxVisible) {
    return { visible: suggestions, startIndex: 0 }
  }

  const half = Math.floor(maxVisible / 2)
  const maxStart = suggestions.length - maxVisible
  const startIndex = Math.min(Math.max(selectedIndex - half, 0), maxStart)

  return {
    visible: suggestions.slice(startIndex, startIndex + maxVisible),
    startIndex,
  }
}
