import { describe, expect, it } from 'vitest'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  getSlashCommands,
  getSuggestionWindow,
  normalizeSlashCommandArgs,
  sanitizeSlashInput,
} from '../../src/tui/slash-commands.js'

describe('slash command helpers', () => {
  it('shows shell slash suggestions when input starts with slash', () => {
    expect(getSlashCommandSuggestions('/c', 'shell')).toEqual([
      { command: '/chat', description: 'start interactive chat mode' },
      { command: '/config', description: 'inspect or update config values' },
      { command: '/clear', description: 'clear the visible session history' },
    ])
  })

  it('shows chat-specific suggestions in chat mode', () => {
    expect(getSlashCommands('chat')).toEqual([
      { command: '/help', description: 'show chat-mode controls' },
      { command: '/docs', description: 'knowledge base documents (chat: /docs generate …)' },
      { command: '/facts', description: 'list, search, or show KB facts' },
      { command: '/clear', description: 'clear the visible session history' },
      { command: '/exit', description: 'leave chat mode' },
    ])
  })

  it('returns no suggestions for non-slash input', () => {
    expect(getSlashCommandSuggestions('query docs', 'shell')).toEqual([])
  })

  it('sanitizes tabs from the raw input value', () => {
    expect(sanitizeSlashInput('/cl\t')).toBe('/cl')
  })

  it('wraps suggestion selection downward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'shell')
    expect(clampSuggestionIndex(suggestions.length, suggestions)).toBe(0)
  })

  it('wraps suggestion selection upward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'shell')
    expect(clampSuggestionIndex(-1, suggestions)).toBe(suggestions.length - 1)
  })

  it('formats the chosen suggestion for explicit completion', () => {
    const [suggestion] = getSlashCommandSuggestions('/he', 'shell')
    expect(applySelectedSuggestion(suggestion)).toBe('/help ')
  })

  it('returns empty completion text when no suggestion is selected', () => {
    expect(applySelectedSuggestion(undefined)).toBe('')
  })

  it('normalizes slash commands before handing off to the CLI runner', () => {
    expect(normalizeSlashCommandArgs(['/query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('leaves normal commands unchanged', () => {
    expect(normalizeSlashCommandArgs(['query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('scrolls the visible suggestion window with the selected row', () => {
    const suggestions = getSlashCommands('shell')
    const { visible, startIndex } = getSuggestionWindow(suggestions, 4, 4)
    expect(startIndex).toBe(2)
    expect(visible.map(item => item.command)).toEqual(['/base', '/query', '/submit', '/invalidate'])
  })

  it('includes /init in shell command list', () => {
    const commands = getSlashCommands('shell')
    expect(commands.some(c => c.command === '/init')).toBe(true)
    expect(commands.find(c => c.command === '/init')?.description).toContain(
      'build a knowledge base'
    )
  })

  it('does not include /init in chat command list', () => {
    const commands = getSlashCommands('chat')
    expect(commands.some(c => c.command === '/init')).toBe(false)
  })

  it('suggests /init when typing /in in shell mode', () => {
    const suggestions = getSlashCommandSuggestions('/in', 'shell')
    expect(suggestions.some(s => s.command === '/init')).toBe(true)
  })

  it('includes /scan in shell command list', () => {
    const commands = getSlashCommands('shell')
    expect(commands.some(c => c.command === '/scan')).toBe(true)
    expect(commands.find(c => c.command === '/scan')?.description).toContain(
      'active or selected KB base'
    )
  })

  it('includes /skill in shell command list', () => {
    const commands = getSlashCommands('shell')
    expect(commands.some(c => c.command === '/skill')).toBe(true)
  })

  it('includes /sync in shell command list', () => {
    const commands = getSlashCommands('shell')
    expect(commands.some(c => c.command === '/sync')).toBe(true)
  })

  it('suggests /skill when typing /sk in shell mode', () => {
    const suggestions = getSlashCommandSuggestions('/sk', 'shell')
    expect(suggestions.some(s => s.command === '/skill')).toBe(true)
  })

  it('returns no suggestions in init mode regardless of input', () => {
    // init mode has no slash commands — input bar is for answering questions
    expect(getSlashCommandSuggestions('/help', 'init')).toEqual([])
  })
})
