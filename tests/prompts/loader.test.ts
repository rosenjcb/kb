import { describe, expect, it } from 'vitest'
import { loadPrompt, loadPromptParts } from '../../src/prompts/loader'

describe('loadPrompt', () => {
  it('[TC-1] loads a prompt file as a trimmed string', () => {
    const text = loadPrompt('chat-router-system.md')
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/^\s/)
    expect(text).not.toMatch(/\s$/)
  })

  it('[TC-2] throws on a missing file', () => {
    expect(() => loadPrompt('does-not-exist.md')).toThrow()
  })
})

describe('loadPromptParts', () => {
  it('[TC-3] splits on the --- divider', () => {
    const { intro, instructions } = loadPromptParts('init-synthesis.md')
    expect(intro.length).toBeGreaterThan(0)
    expect(instructions.length).toBeGreaterThan(0)
  })

  it('[TC-4] trims both parts', () => {
    const { intro, instructions } = loadPromptParts('init-refinement.md')
    expect(intro).not.toMatch(/^\s/)
    expect(intro).not.toMatch(/\s$/)
    expect(instructions).not.toMatch(/^\s/)
    expect(instructions).not.toMatch(/\s$/)
  })

  it('[TC-5] intro does not contain the divider', () => {
    const { intro } = loadPromptParts('init-quality.md')
    expect(intro).not.toContain('\n---\n')
  })

  it('[TC-6] instructions does not contain the divider', () => {
    const { instructions } = loadPromptParts('init-enrichment.md')
    expect(instructions).not.toContain('\n---\n')
  })

  it('[TC-7] throws when the prompt file has no --- divider', () => {
    // chat-router-system.md is a single-part prompt with no divider
    expect(() => loadPromptParts('chat-router-system.md')).toThrow(/missing the \\n---\\n divider/)
  })

  it('[TC-8] all two-part prompt files parse without throwing', () => {
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
