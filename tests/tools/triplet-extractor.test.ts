import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import { extractFactTriplet, extractFactTriplets } from '@kb/core/tools/triplet-extractor.js'

function mockLlm(response: string): LLMProvider {
  return {
    call: async () => ({ text: response, inputTokens: 0, outputTokens: 0 }),
  } as unknown as LLMProvider
}

describe('extractFactTriplets', () => {
  it('[TC-1] parses a single-element JSON array', async () => {
    const llm = mockLlm(
      '[{"subject":"QueryOrchestrator","predicate":"seeds","object":"hypotheses in parallel"}]'
    )
    const result = await extractFactTriplets(llm, 'any input')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      subject: 'QueryOrchestrator',
      predicate: 'seeds',
      object: 'hypotheses in parallel',
    })
  })

  it('[TC-2] parses a multi-element array from a compound sentence', async () => {
    const llm = mockLlm(
      '[{"subject":"CodeGraphWalker","predicate":"handles","object":"TypeScript and JS files"},{"subject":"TreeSitterIndexer","predicate":"handles","object":"all other files"}]'
    )
    const result = await extractFactTriplets(llm, 'CodeGraphWalker handles TS, TreeSitterIndexer handles the rest')
    expect(result).toHaveLength(2)
    expect(result[0]?.subject).toBe('CodeGraphWalker')
    expect(result[1]?.subject).toBe('TreeSitterIndexer')
  })

  it('[TC-3] falls back to bare object for backwards compat', async () => {
    const llm = mockLlm('{"subject":"kb init","predicate":"runs","object":"7 cycles"}')
    const result = await extractFactTriplets(llm, 'any input')
    expect(result).toHaveLength(1)
    expect(result[0]?.subject).toBe('kb init')
  })

  it('[TC-4] ignores surrounding prose and extracts the JSON array', async () => {
    const llm = mockLlm(
      'Here are the triples:\n[{"subject":"A","predicate":"uses","object":"B"}]\nDone.'
    )
    const result = await extractFactTriplets(llm, 'any input')
    expect(result).toHaveLength(1)
    expect(result[0]?.subject).toBe('A')
  })

  it('[TC-5] throws when output has no JSON', async () => {
    const llm = mockLlm('I cannot extract triples from this.')
    await expect(extractFactTriplets(llm, 'any')).rejects.toThrow('triplet-extract')
  })

  it('[TC-6] throws when array contains no valid triples', async () => {
    const llm = mockLlm('[{"foo":"bar"}]')
    await expect(extractFactTriplets(llm, 'any')).rejects.toThrow('triplet-extract')
  })

  it('[TC-7] skips malformed rows but keeps valid ones', async () => {
    const llm = mockLlm(
      '[{"subject":"A","predicate":"uses","object":"B"},{"bad":"row"},{"subject":"C","predicate":"reads","object":"D"}]'
    )
    const result = await extractFactTriplets(llm, 'any')
    expect(result).toHaveLength(2)
    expect(result[0]?.subject).toBe('A')
    expect(result[1]?.subject).toBe('C')
  })
})

describe('extractFactTriplet (single convenience wrapper)', () => {
  it('[TC-8] returns the first triplet from a multi-triple response', async () => {
    const llm = mockLlm(
      '[{"subject":"X","predicate":"does","object":"Y"},{"subject":"A","predicate":"uses","object":"B"}]'
    )
    const result = await extractFactTriplet(llm, 'any')
    expect(result.subject).toBe('X')
  })
})
