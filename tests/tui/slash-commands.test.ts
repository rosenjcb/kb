import { describe, expect, it } from 'vitest'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  getSlashCommands,
  getSuggestionWindow,
  normalizeSlashCommandArgs,
  parseSlashInput,
  resolveSlashSuggestions,
  sanitizeSlashInput,
} from '@kb/client/tui/slash-commands.js'

describe('slash command helpers', () => {
  it('[TC-68] shows slash suggestions when input starts with slash', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(suggestions.some(s => s.command === '/clear')).toBe(true)
    expect(suggestions.some(s => s.command === '/config')).toBe(false)
  })

  it('[TC-69] returns the full command list for chat mode', () => {
    const commands = getSlashCommands('chat')
    expect(commands.some(c => c.command === '/query')).toBe(true)
    // docs was removed — it must not resurface in the command list.
    expect(commands.some(c => c.command === '/docs')).toBe(false)
    expect(commands.some(c => c.command === '/facts')).toBe(true)
    expect(commands.some(c => c.command === '/graph')).toBe(true)
    expect(commands.some(c => c.command === '/entities')).toBe(true)
    expect(commands.some(c => c.command === '/base')).toBe(true)
    expect(commands.some(c => c.command === '/config')).toBe(false)
    expect(commands.some(c => c.command === '/skills')).toBe(true)
    expect(commands.some(c => c.command === '/sync')).toBe(true)
    expect(commands.some(c => c.command === '/logs')).toBe(true)
    expect(commands.some(c => c.command === '/session')).toBe(true)
    expect(commands.some(c => c.command === '/help')).toBe(true)
    expect(commands.some(c => c.command === '/clear')).toBe(true)
    expect(commands.some(c => c.command === '/exit')).toBe(true)
  })

  it('[TC-70] does not include /chat in the command list (chat is the app itself now)', () => {
    expect(getSlashCommands('chat').some(c => c.command === '/chat')).toBe(false)
  })

  it('[TC-71] returns no suggestions for non-slash input', () => {
    expect(getSlashCommandSuggestions('query docs', 'chat')).toEqual([])
  })

  it('[TC-72] sanitizes tabs from the raw input value', () => {
    expect(sanitizeSlashInput('/cl\t')).toBe('/cl')
  })

  it('[TC-73] wraps suggestion selection downward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(suggestions.length, suggestions)).toBe(0)
  })

  it('[TC-74] wraps suggestion selection upward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(-1, suggestions)).toBe(suggestions.length - 1)
  })

  it('[TC-75] formats the chosen suggestion for explicit completion', () => {
    const [suggestion] = getSlashCommandSuggestions('/he', 'chat')
    expect(applySelectedSuggestion(suggestion, '/he')).toBe('/help ')
  })

  it('[TC-76] returns empty completion text when no suggestion is selected', () => {
    expect(applySelectedSuggestion(undefined)).toBe('')
  })

  it('[TC-77] normalizes slash commands before handing off to the CLI runner', () => {
    expect(normalizeSlashCommandArgs(['/query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('[TC-78] leaves normal commands unchanged', () => {
    expect(normalizeSlashCommandArgs(['query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('[TC-79] scrolls the visible suggestion window with the selected row', () => {
    const suggestions = getSlashCommands('chat')
    const { visible, startIndex } = getSuggestionWindow(suggestions, 4, 4)
    expect(visible.length).toBe(4)
    expect(startIndex).toBeGreaterThanOrEqual(0)
  })

  it('[TC-80] suggests /skills when typing /sk', () => {
    const suggestions = getSlashCommandSuggestions('/sk', 'chat')
    expect(suggestions.some(s => s.command === '/skills')).toBe(true)
  })

  it('[TC-81] suggests logs subcommands when typing /logs c', () => {
    const suggestions = resolveSlashSuggestions('/logs c', 'idle')
    expect(suggestions.some(s => s.command === '/logs compare')).toBe(true)
  })

  it('[TC-82] suggests /facts list when typing /facts li', () => {
    const suggestions = resolveSlashSuggestions('/facts li', 'idle')
    expect(suggestions.some(s => s.command === '/facts list')).toBe(true)
  })

  it('[TC-86] shows /cancel only in init-flow contexts, not at idle', () => {
    expect(resolveSlashSuggestions('/ca', 'scan-base-picker').some(s => s.command === '/cancel')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/ca', 'init-free-text').some(s => s.command === '/cancel')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/ca', 'idle').some(s => s.command === '/cancel')).toBe(false)
  })

  it('[TC-87] completes multi-segment commands', () => {
    const [suggestion] = resolveSlashSuggestions('/logs sh', 'idle')
    expect(applySelectedSuggestion(suggestion, '/logs sh')).toBe('/logs show ')
  })

  it('[TC-88] suppresses suggestions after complete path with trailing args', () => {
    expect(parseSlashInput('/facts search "foo"').hasTrailingArgs).toBe(true)
    expect(resolveSlashSuggestions('/facts search "foo"', 'idle')).toEqual([])
  })
})
