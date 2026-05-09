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
  it('shows slash suggestions when input starts with slash', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(suggestions.some(s => s.command === '/config')).toBe(true)
    expect(suggestions.some(s => s.command === '/clear')).toBe(true)
  })

  it('returns the full command list for chat mode', () => {
    const commands = getSlashCommands('chat')
    expect(commands.some(c => c.command === '/init')).toBe(true)
    expect(commands.some(c => c.command === '/scan')).toBe(true)
    expect(commands.some(c => c.command === '/query')).toBe(true)
    expect(commands.some(c => c.command === '/submit')).toBe(true)
    expect(commands.some(c => c.command === '/invalidate')).toBe(true)
    expect(commands.some(c => c.command === '/docs')).toBe(true)
    expect(commands.some(c => c.command === '/facts')).toBe(true)
    expect(commands.some(c => c.command === '/graph')).toBe(true)
    expect(commands.some(c => c.command === '/base')).toBe(true)
    expect(commands.some(c => c.command === '/config')).toBe(true)
    expect(commands.some(c => c.command === '/skill')).toBe(true)
    expect(commands.some(c => c.command === '/sync')).toBe(true)
    expect(commands.some(c => c.command === '/help')).toBe(true)
    expect(commands.some(c => c.command === '/clear')).toBe(true)
    expect(commands.some(c => c.command === '/exit')).toBe(true)
  })

  it('does not include /chat in the command list (chat is the app itself now)', () => {
    expect(getSlashCommands('chat').some(c => c.command === '/chat')).toBe(false)
  })

  it('returns no suggestions for non-slash input', () => {
    expect(getSlashCommandSuggestions('query docs', 'chat')).toEqual([])
  })

  it('sanitizes tabs from the raw input value', () => {
    expect(sanitizeSlashInput('/cl\t')).toBe('/cl')
  })

  it('wraps suggestion selection downward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(suggestions.length, suggestions)).toBe(0)
  })

  it('wraps suggestion selection upward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(-1, suggestions)).toBe(suggestions.length - 1)
  })

  it('formats the chosen suggestion for explicit completion', () => {
    const [suggestion] = getSlashCommandSuggestions('/he', 'chat')
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
    const suggestions = getSlashCommands('chat')
    const { visible, startIndex } = getSuggestionWindow(suggestions, 4, 4)
    expect(visible.length).toBe(4)
    expect(startIndex).toBeGreaterThanOrEqual(0)
  })

  it('includes /init in the command list with correct description', () => {
    const commands = getSlashCommands('chat')
    const initCmd = commands.find(c => c.command === '/init')
    expect(initCmd).toBeDefined()
    expect(initCmd?.description).toContain('build a knowledge base')
  })

  it('includes /scan in the command list with correct description', () => {
    const commands = getSlashCommands('chat')
    const scanCmd = commands.find(c => c.command === '/scan')
    expect(scanCmd).toBeDefined()
    expect(scanCmd?.description).toContain('active or selected KB base')
  })

  it('suggests /init when typing /in', () => {
    const suggestions = getSlashCommandSuggestions('/in', 'chat')
    expect(suggestions.some(s => s.command === '/init')).toBe(true)
  })

  it('suggests /skill when typing /sk', () => {
    const suggestions = getSlashCommandSuggestions('/sk', 'chat')
    expect(suggestions.some(s => s.command === '/skill')).toBe(true)
  })
})
