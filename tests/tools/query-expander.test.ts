import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '../../src/core/types'
import { expandQuery, shouldExpandQuery } from '../../src/tools/query-expander'

function mockLlm(response: string): LLMProvider {
  return {
    call: async () => ({ text: response, inputTokens: 0, outputTokens: 0 }),
  } as unknown as LLMProvider
}

describe('shouldExpandQuery', () => {
  it('[TC-52] expands single-token queries', () => {
    expect(shouldExpandQuery('fzf')).toBe(true)
  })

  it('[TC-53] expands when only stop words plus one noun remain', () => {
    expect(shouldExpandQuery('what is fzf?')).toBe(true)
  })

  it('[TC-54] expands two-meaningful-token queries', () => {
    expect(shouldExpandQuery('fzf overview')).toBe(true)
  })

  it('[TC-55] does not expand three-meaningful-token queries', () => {
    expect(shouldExpandQuery('how does fzf handle signals')).toBe(false)
  })

  it('[TC-56] does not expand specific multi-word queries', () => {
    expect(shouldExpandQuery('fzf fuzzy matching algorithm scoring')).toBe(false)
  })

  it('[TC-57] returns true for empty query', () => {
    expect(shouldExpandQuery('')).toBe(true)
  })
})

describe('expandQuery', () => {
  it('[TC-58] parses a valid JSON array from LLM output', async () => {
    const llm = mockLlm('["fzf purpose overview", "fzf main capabilities", "fzf use cases"]')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('fzf purpose overview')
    expect(result[2]).toBe('fzf use cases')
  })

  it('[TC-59] strips prose surrounding the JSON array', async () => {
    const llm = mockLlm('Here are the expansions:\n["fzf description", "fzf features"]\nDone.')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('fzf description')
  })

  it('[TC-60] returns empty array when LLM returns no JSON', async () => {
    const llm = mockLlm('I cannot expand this query.')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(0)
  })

  it('[TC-61] returns empty array on malformed JSON', async () => {
    const llm = mockLlm('[not valid json]')
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(0)
  })

  it('[TC-62] caps results at 4 even if LLM returns more', async () => {
    const llm = mockLlm(
      '["a", "b", "c", "d", "e", "f"]'
    )
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(4)
  })

  it('[TC-63] filters out non-string entries', async () => {
    const llm = mockLlm('["fzf overview", 42, null, "fzf features"]')
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('fzf overview')
    expect(result[1]).toBe('fzf features')
  })
})
