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
    expect(suggestions.some(s => s.command === '/config')).toBe(true)
    expect(suggestions.some(s => s.command === '/clear')).toBe(true)
  })

  it('[TC-69] returns the full command list for chat mode', () => {
    const commands = getSlashCommands('chat')
    expect(commands.some(c => c.command === '/init')).toBe(true)
    expect(commands.some(c => c.command === '/scan')).toBe(true)
    expect(commands.some(c => c.command === '/query')).toBe(true)
    expect(commands.some(c => c.command === '/docs')).toBe(true)
    expect(commands.some(c => c.command === '/facts')).toBe(true)
    expect(commands.some(c => c.command === '/graph')).toBe(true)
    expect(commands.some(c => c.command === '/base')).toBe(true)
    expect(commands.some(c => c.command === '/config')).toBe(true)
    expect(commands.some(c => c.command === '/skills')).toBe(true)
    expect(commands.some(c => c.command === '/sync')).toBe(true)
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

  it('[TC-80] includes /init in the command list with correct description', () => {
    const commands = getSlashCommands('chat')
    const initCmd = commands.find(c => c.command === '/init')
    expect(initCmd).toBeDefined()
    expect(initCmd?.description).toContain('build a knowledge base')
  })

  it('[TC-81] includes /scan in the command list with correct description', () => {
    const commands = getSlashCommands('chat')
    const scanCmd = commands.find(c => c.command === '/scan')
    expect(scanCmd).toBeDefined()
    expect(scanCmd?.description).toContain('re-index')
  })

  it('[TC-82] suggests /init when typing /in', () => {
    const suggestions = getSlashCommandSuggestions('/in', 'chat')
    expect(suggestions.some(s => s.command === '/init')).toBe(true)
  })

  it('[TC-83] suggests /skills when typing /sk', () => {
    const suggestions = getSlashCommandSuggestions('/sk', 'chat')
    expect(suggestions.some(s => s.command === '/skills')).toBe(true)
  })

  it('[TC-84] suggests docs subcommands when typing /docs g', () => {
    const suggestions = resolveSlashSuggestions('/docs g', 'idle')
    expect(suggestions.some(s => s.command === '/docs generate')).toBe(true)
  })

  it('[TC-85] suggests /facts list when typing /facts li', () => {
    const suggestions = resolveSlashSuggestions('/facts li', 'idle')
    expect(suggestions.some(s => s.command === '/facts list')).toBe(true)
  })

  it('[TC-86] shows /accept in docs-generate-review and named-list-confirm contexts', () => {
    expect(resolveSlashSuggestions('/ac', 'docs-generate-review').some(s => s.command === '/accept')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/ac', 'named-list-confirm').some(s => s.command === '/accept')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/ac', 'idle').some(s => s.command === '/accept')).toBe(false)
    expect(resolveSlashSuggestions('/ac', 'init-question').some(s => s.command === '/accept')).toBe(false)
  })

  it('[TC-87] shows /complete in init-question and docs-generate-question contexts', () => {
    expect(resolveSlashSuggestions('/co', 'init-question').some(s => s.command === '/complete')).toBe(true)
    expect(resolveSlashSuggestions('/co', 'docs-generate-question').some(s => s.command === '/complete')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/co', 'idle').some(s => s.command === '/complete')).toBe(false)
  })

  it('[TC-88] shows /skip in docs-generate-question context', () => {
    expect(resolveSlashSuggestions('/sk', 'docs-generate-question').some(s => s.command === '/skip')).toBe(
      true
    )
  })

  it('[TC-89] shows /cancel in every context', () => {
    expect(resolveSlashSuggestions('/ca', 'docs-generate-review').some(s => s.command === '/cancel')).toBe(
      true
    )
    expect(resolveSlashSuggestions('/ca', 'idle').some(s => s.command === '/cancel')).toBe(true)
  })

  it('[TC-90] completes multi-segment commands', () => {
    const [suggestion] = resolveSlashSuggestions('/docs g', 'idle')
    expect(applySelectedSuggestion(suggestion, '/docs g')).toBe('/docs generate ')
  })

  it('[TC-91] suppresses suggestions after complete path with trailing args', () => {
    expect(parseSlashInput('/docs generate "foo"').hasTrailingArgs).toBe(true)
    expect(resolveSlashSuggestions('/docs generate "foo"', 'idle')).toEqual([])
  })
})
