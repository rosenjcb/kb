import type { TuiMode } from './types.js'

export interface SlashCommand {
  command: string
  description: string
}

const CHAT_COMMANDS: SlashCommand[] = [
  { command: '/query', description: 'search the knowledge base' },
  { command: '/submit', description: 'store a new fact or checkpoint' },
  { command: '/invalidate', description: 'remove or replace stale KB facts' },
  { command: '/init', description: 'build a knowledge base from this repo' },
  { command: '/scan', description: 'scan this repo into the active or selected KB base' },
  { command: '/base', description: 'manage KB bases (use, delete)' },
  { command: '/docs', description: 'browse or generate KB documents' },
  { command: '/facts', description: 'list, search, or show KB facts' },
  { command: '/graph', description: 'inspect or edit the knowledge graph' },
  { command: '/publish', description: 'publish docs to the external sink' },
  { command: '/sync', description: 'install the latest published KB release' },
  { command: '/skills', description: 'manage agent skills' },
  { command: '/config', description: 'inspect or update config values' },
  { command: '/logs', description: 'browse and compare run reports' },
  { command: '/help', description: 'show available commands' },
  { command: '/clear', description: 'clear the visible session history' },
  { command: '/exit', description: 'quit kb' },
]

export function getSlashCommands(_mode: TuiMode): SlashCommand[] {
  return CHAT_COMMANDS
}

export function getSlashCommandSuggestions(value: string, mode: TuiMode): SlashCommand[] {
  if (!value.startsWith('/')) return []

  const normalized = value.trim().toLowerCase()
  return getSlashCommands(mode).filter(({ command }) => command.startsWith(normalized))
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

export function applySelectedSuggestion(suggestion?: SlashCommand): string {
  return suggestion ? `${suggestion.command} ` : ''
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
