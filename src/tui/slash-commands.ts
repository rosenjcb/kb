import type { TuiMode } from './types.js'

export interface SlashCommand {
  command: string
  description: string
}

const SHELL_COMMANDS: SlashCommand[] = [
  { command: '/init', description: 'initialize or rescan a knowledge base' },
  { command: '/base', description: 'manage KB bases (use, delete)' },
  { command: '/query', description: 'search the knowledge base' },
  { command: '/submit', description: 'store a new fact or checkpoint' },
  { command: '/validate', description: 'check whether a fact is supported' },
  { command: '/explain', description: 'explain a fact or change id' },
  { command: '/chat', description: 'start interactive chat mode' },
  { command: '/docs', description: 'list or view knowledge base documents' },
  { command: '/graph', description: 'inspect or edit the knowledge graph (see kb graph --help)' },
  { command: '/publish', description: 'publish docs to the external sink' },
  { command: '/sync', description: 'fast-forward main, rebuild, and refresh kb' },
  { command: '/skill', description: 'manage agent skills' },
  { command: '/config', description: 'inspect or update config values' },
  { command: '/help', description: 'show kb CLI and TUI help' },
  { command: '/clear', description: 'clear the visible session history' },
  { command: '/exit', description: 'quit the TUI' },
]

const CHAT_COMMANDS: SlashCommand[] = [
  { command: '/help', description: 'show chat-mode controls' },
  { command: '/clear', description: 'clear the visible session history' },
  { command: '/exit', description: 'leave chat mode' },
]

export function getSlashCommands(mode: TuiMode): SlashCommand[] {
  if (mode === 'chat') return CHAT_COMMANDS
  if (mode === 'init') return []
  return SHELL_COMMANDS
}

export function getSlashCommandSuggestions(value: string, mode: TuiMode): SlashCommand[] {
  if (!value.startsWith('/')) return []
  if (mode === 'init') return []

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
