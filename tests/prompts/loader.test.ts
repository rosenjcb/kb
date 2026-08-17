import { describe, expect, it } from 'vitest'
import { loadPrompt, loadPromptParts } from '@kb/core/prompts/loader.js'

describe('loadPrompt', () => {
  it('[TC-T1CF] loads a prompt file as a trimmed string', () => {
    const text = loadPrompt('chat-router-system.md')
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/^\s/)
    expect(text).not.toMatch(/\s$/)
  })

  it('[TC-TSOP] throws on a missing file', () => {
    expect(() => loadPrompt('does-not-exist.md')).toThrow()
  })
})

describe('loadPromptParts', () => {
  it('[TC-OIPJ] splits on the --- divider', () => {
    const { intro, instructions } = loadPromptParts('init-synthesis.md')
    expect(intro.length).toBeGreaterThan(0)
    expect(instructions.length).toBeGreaterThan(0)
  })

  it('[TC-AQ32] trims both parts', () => {
    const { intro, instructions } = loadPromptParts('init-refinement.md')
    expect(intro).not.toMatch(/^\s/)
    expect(intro).not.toMatch(/\s$/)
    expect(instructions).not.toMatch(/^\s/)
    expect(instructions).not.toMatch(/\s$/)
  })

  it('[TC-U1R6] intro does not contain the divider', () => {
    const { intro } = loadPromptParts('init-quality.md')
    expect(intro).not.toContain('\n---\n')
  })

  it('[TC-EYGP] instructions does not contain the divider', () => {
    const { instructions } = loadPromptParts('init-enrichment.md')
    expect(instructions).not.toContain('\n---\n')
  })

  it('[TC-THDS] throws when the prompt file has no --- divider', () => {
    // chat-router-system.md is a single-part prompt with no divider
    expect(() => loadPromptParts('chat-router-system.md')).toThrow(/missing the \\n---\\n divider/)
  })

  it('[TC-EL9S] all two-part prompt files parse without throwing', () => {
    const twoPartFiles = [
      'init-synthesis.md',
      'init-refinement.md',
      'init-quality.md',
      'init-enrichment.md',
    ]
    for (const name of twoPartFiles) {
      expect(() => loadPromptParts(name)).not.toThrow()
    }
  })
})
