import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '../../src/core/types'
import type { QueryResult } from '../../src/tools/facts-document-reader'
import {
  filterRelevantFacts,
  shouldRunRelevanceFilter,
} from '../../src/tools/facts-relevance-filter'

function makeResult(id: string, title: string): QueryResult {
  return {
    metadata: {
      id,
      title,
      filePath: `fact://${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    content: title,
  }
}

function mockLlm(keepIds: string[]): LLMProvider {
  return {
    call: async () => ({
      text: JSON.stringify(keepIds),
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  } as unknown as LLMProvider
}

function errorLlm(): LLMProvider {
  return {
    call: async () => {
      throw new Error('LLM unavailable')
    },
  } as unknown as LLMProvider
}

function badResponseLlm(): LLMProvider {
  return {
    call: async () => ({
      text: 'Sorry, I cannot help with that.',
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  } as unknown as LLMProvider
}

describe('shouldRunRelevanceFilter', () => {
  it('Given many results, then returns true', () => {
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldRunRelevanceFilter(results)).toBe(true)
  })

  it('Given few results (at or below threshold), then returns false', () => {
    const results = Array.from({ length: 10 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldRunRelevanceFilter(results)).toBe(false)
  })
})

describe('filterRelevantFacts', () => {
  it('Given fewer than 20 results, then returns input unchanged without LLM call', async () => {
    let called = false
    const llm: LLMProvider = {
      call: async () => {
        called = true
        return { text: '[]', stopReason: 'end_turn', toolUses: [], usage: { inputTokens: 0, outputTokens: 0 } }
      },
    } as unknown as LLMProvider
    const results = Array.from({ length: 15 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const out = await filterRelevantFacts(llm, 'test query', results)
    expect(out).toBe(results)
    expect(called).toBe(false)
  })

  it('Given 25 results and LLM returns 12 relevant IDs, then output contains only those 12 facts', async () => {
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    // 12 IDs — above the minKeep floor of max(10, ceil(25*0.15)=4)=10
    const keepIds = ['f-0', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6', 'f-7', 'f-8', 'f-9', 'f-10', 'f-11']
    const llm = mockLlm(keepIds)

    const out = await filterRelevantFacts(llm, 'test query', results)
    expect(out.map(r => r.metadata.id)).toEqual(expect.arrayContaining(keepIds))
    expect(out.length).toBe(12)
  })

  it('Given LLM throws, then falls back to original results', async () => {
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const out = await filterRelevantFacts(errorLlm(), 'test query', results)
    expect(out).toBe(results)
  })

  it('Given LLM returns non-JSON text, then falls back to original results', async () => {
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const out = await filterRelevantFacts(badResponseLlm(), 'test query', results)
    expect(out).toBe(results)
  })

  it('Given LLM filters too aggressively (below minKeep), then falls back to original results', async () => {
    // 25 results, minKeep = max(10, ceil(25*0.15)=4) = 10
    // LLM returns only 2 IDs — below minKeep threshold
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const llm = mockLlm(['f-0', 'f-1'])
    const out = await filterRelevantFacts(llm, 'test query', results)
    expect(out).toBe(results)
  })

  it('Given LLM returns IDs that include unknown ones, then unknown IDs are silently dropped', async () => {
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    // Mix of valid and unknown IDs — enough valid ones to pass minKeep
    const keepIds = ['f-0', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6', 'f-7', 'f-8', 'f-9', 'ghost-99']
    const llm = mockLlm(keepIds)
    const out = await filterRelevantFacts(llm, 'test query', results)
    const outIds = out.map(r => r.metadata.id)
    expect(outIds).not.toContain('ghost-99')
    expect(out.length).toBe(10)
  })

  it('Given results with titles longer than 120 chars, then LLM is still called without error', async () => {
    const longTitle = 'x'.repeat(200)
    const results = Array.from({ length: 25 }, (_, i) => makeResult(`f-${i}`, longTitle))
    const keepIds = results.slice(0, 12).map(r => r.metadata.id)
    const llm = mockLlm(keepIds)
    const out = await filterRelevantFacts(llm, 'test query', results)
    expect(out.length).toBe(12)
  })
})
