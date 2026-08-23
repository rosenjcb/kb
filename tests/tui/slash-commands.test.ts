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
  it('[TC-U3RV] shows slash suggestions when input starts with slash', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(suggestions.some(s => s.command === '/clear')).toBe(true)
    expect(suggestions.some(s => s.command === '/config')).toBe(false)
  })

  it('[TC-VG2C] returns the full command list for chat mode', () => {
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

  it('[TC-794C] does not include /chat in the command list (chat is the app itself now)', () => {
    expect(getSlashCommands('chat').some(c => c.command === '/chat')).toBe(false)
  })

  it('[TC-FJZE] returns no suggestions for non-slash input', () => {
    expect(getSlashCommandSuggestions('query docs', 'chat')).toEqual([])
  })

  it('[TC-XZZV] sanitizes tabs from the raw input value', () => {
    expect(sanitizeSlashInput('/cl\t')).toBe('/cl')
  })

  it('[TC-6X5E] wraps suggestion selection downward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(suggestions.length, suggestions)).toBe(0)
  })

  it('[TC-3TQI] wraps suggestion selection upward', () => {
    const suggestions = getSlashCommandSuggestions('/c', 'chat')
    expect(clampSuggestionIndex(-1, suggestions)).toBe(suggestions.length - 1)
  })

  it('[TC-VKK0] formats the chosen suggestion for explicit completion', () => {
    const [suggestion] = getSlashCommandSuggestions('/he', 'chat')
    expect(applySelectedSuggestion(suggestion, '/he')).toBe('/help ')
  })

  it('[TC-0NWQ] returns empty completion text when no suggestion is selected', () => {
    expect(applySelectedSuggestion(undefined)).toBe('')
  })

  it('[TC-LXSH] normalizes slash commands before handing off to the CLI runner', () => {
    expect(normalizeSlashCommandArgs(['/query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('[TC-PTRF] leaves normal commands unchanged', () => {
    expect(normalizeSlashCommandArgs(['query', 'graph'])).toEqual(['query', 'graph'])
  })

  it('[TC-JXSQ] scrolls the visible suggestion window with the selected row', () => {
    const suggestions = getSlashCommands('chat')
    const { visible, startIndex } = getSuggestionWindow(suggestions, 4, 4)
    expect(visible.length).toBe(4)
    expect(startIndex).toBeGreaterThanOrEqual(0)
  })

  it('[TC-A1EO] suggests /skills when typing /sk', () => {
    const suggestions = getSlashCommandSuggestions('/sk', 'chat')
    expect(suggestions.some(s => s.command === '/skills')).toBe(true)
  })

  it('[TC-P7AX] suggests logs subcommands when typing /logs c', () => {
    const suggestions = resolveSlashSuggestions('/logs c', 'idle')
    expect(suggestions.some(s => s.command === '/logs compare')).toBe(true)
  })

  it('[TC-0FT3] suggests /facts list when typing /facts li', () => {
    const suggestions = resolveSlashSuggestions('/facts li', 'idle')
    expect(suggestions.some(s => s.command === '/facts list')).toBe(true)
  })

  it('[TC-FV3W] completes multi-segment commands', () => {
    const [suggestion] = resolveSlashSuggestions('/logs sh', 'idle')
    expect(applySelectedSuggestion(suggestion, '/logs sh')).toBe('/logs show ')
  })

  it('[TC-LMFB] suppresses suggestions after complete path with trailing args', () => {
    expect(parseSlashInput('/facts search "foo"').hasTrailingArgs).toBe(true)
    expect(resolveSlashSuggestions('/facts search "foo"', 'idle')).toEqual([])
  })

  it('[TC-LPE9] orders the command menu by catalog section, not alphabetically', () => {
    const order = getSlashCommands('chat').map(c => c.command)
    // Section order: Ask & sessions → Knowledge → System → More.
    expect(order.indexOf('/base')).toBeLessThan(order.indexOf('/graph'))
    expect(order.indexOf('/graph')).toBeLessThan(order.indexOf('/skills'))
    expect(order.indexOf('/skills')).toBeLessThan(order.indexOf('/help'))
    // Within a section, the declared order holds (query before session before clear).
    expect(order.indexOf('/query')).toBeLessThan(order.indexOf('/session'))
    expect(order.indexOf('/session')).toBeLessThan(order.indexOf('/clear'))
    // /exit is last so people always see how to leave.
    expect(order.indexOf('/help')).toBeLessThan(order.indexOf('/exit'))
    expect(order.indexOf('/exit')).toBe(order.length - 1)
  })
})
