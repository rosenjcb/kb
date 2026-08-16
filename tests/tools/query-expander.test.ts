import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import { expandQuery, shouldExpandQuery } from '@kb/core/tools/query-expander.js'

function mockLlm(response: string): LLMProvider {
  return {
    call: async () => ({ text: response, inputTokens: 0, outputTokens: 0 }),
  } as unknown as LLMProvider
}

describe('shouldExpandQuery', () => {
  it('[TC-8524] expands single-token queries', () => {
    expect(shouldExpandQuery('fzf')).toBe(true)
  })

  it('[TC-NXF3] expands when only stop words plus one noun remain', () => {
    expect(shouldExpandQuery('what is fzf?')).toBe(true)
  })

  it('[TC-OAC0] expands two-meaningful-token queries', () => {
    expect(shouldExpandQuery('fzf overview')).toBe(true)
  })

  it('[TC-WVGK] does not expand three-meaningful-token queries', () => {
    expect(shouldExpandQuery('how does fzf handle signals')).toBe(false)
  })

  it('[TC-8W14] does not expand specific multi-word queries', () => {
    expect(shouldExpandQuery('fzf fuzzy matching algorithm scoring')).toBe(false)
  })

  it('[TC-DVOT] returns true for empty query', () => {
    expect(shouldExpandQuery('')).toBe(true)
  })
})

describe('expandQuery', () => {
  it('[TC-NXAE] parses a valid JSON array from LLM output', async () => {
    const llm = mockLlm('["fzf purpose overview", "fzf main capabilities", "fzf use cases"]')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('fzf purpose overview')
    expect(result[2]).toBe('fzf use cases')
  })

  it('[TC-MXKK] strips prose surrounding the JSON array', async () => {
    const llm = mockLlm('Here are the expansions:\n["fzf description", "fzf features"]\nDone.')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('fzf description')
  })

  it('[TC-DTQ2] returns empty array when LLM returns no JSON', async () => {
    const llm = mockLlm('I cannot expand this query.')
    const result = await expandQuery(llm, 'what is fzf?')
    expect(result).toHaveLength(0)
  })

  it('[TC-VSY5] returns empty array on malformed JSON', async () => {
    const llm = mockLlm('[not valid json]')
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(0)
  })

  it('[TC-7ASC] caps results at 4 even if LLM returns more', async () => {
    const llm = mockLlm(
      '["a", "b", "c", "d", "e", "f"]'
    )
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(4)
  })

  it('[TC-QSHK] filters out non-string entries', async () => {
    const llm = mockLlm('["fzf overview", 42, null, "fzf features"]')
    const result = await expandQuery(llm, 'fzf')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('fzf overview')
    expect(result[1]).toBe('fzf features')
  })
})
