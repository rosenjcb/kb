import { describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '../../src/core/types'
import {
  type CuratorRequery,
  curateFacts,
  parseVerdict,
  shouldCurate,
} from '../../src/tools/fact-curator'
import type { QueryResult } from '../../src/tools/facts-document-reader'

function makeResult(id: string, title: string, content?: string): QueryResult {
  return {
    metadata: {
      id,
      title,
      filePath: `fact://${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    content: content ?? title,
  }
}

/** LLM that returns a fixed JSON verdict (optionally a different verdict per call). */
function verdictLlm(...verdicts: object[]): LLMProvider {
  let i = 0
  return {
    call: vi.fn(async () => {
      const v = verdicts[Math.min(i, verdicts.length - 1)]
      i++
      return {
        text: JSON.stringify(v),
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      }
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

describe('shouldCurate', () => {
  it('Given more than the threshold of results, then returns true', () => {
    const results = Array.from({ length: 13 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldCurate(results)).toBe(true)
  })

  it('Given few results, then returns false', () => {
    const results = Array.from({ length: 8 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldCurate(results)).toBe(false)
  })
})

describe('parseVerdict', () => {
  it('Given a JSON object embedded in prose, then it extracts keep/gaps/sufficient', () => {
    const v = parseVerdict('Sure: {"keep":["a","b"],"gaps":["more"],"sufficient":true} done')
    expect([...v.keep]).toEqual(['a', 'b'])
    expect(v.gaps).toEqual(['more'])
    expect(v.sufficient).toBe(true)
  })

  it('Given no JSON, then it throws', () => {
    expect(() => parseVerdict('no json here')).toThrow()
  })
})

describe('curateFacts', () => {
  it('Given irrelevant facts, then the judge hard-drops them below the old 15% floor', async () => {
    // 20 facts; only 2 are on-topic. The old filter would refuse to drop below ~3.
    const results = [
      makeResult('keep-1', 'authentication token rotation'),
      makeResult('keep-2', 'authentication session expiry'),
      ...Array.from({ length: 18 }, (_, i) => makeResult(`junk-${i}`, `rendering frame buffer ${i}`)),
    ]
    const llm = verdictLlm({ keep: ['keep-1', 'keep-2'], gaps: [], sufficient: true })

    const { results: out, record } = await curateFacts({
      llm,
      query: 'how does authentication work',
      results,
    })

    expect(out.map(r => r.metadata.id).sort()).toEqual(['keep-1', 'keep-2'])
    expect(record.dropped).toHaveLength(18)
    expect(record.sufficient).toBe(true)
  })

  it('Given high token overlap, then a fact is auto-kept even if the judge omits it', async () => {
    const results = [
      makeResult('auto', 'authentication works via token rotation'),
      ...Array.from({ length: 15 }, (_, i) => makeResult(`x-${i}`, `unrelated ${i}`)),
    ]
    // Judge keeps nothing — auto-keep must still rescue the high-overlap fact.
    const llm = verdictLlm({ keep: [], gaps: [], sufficient: true })

    const { results: out, record } = await curateFacts({
      llm,
      query: 'authentication token rotation',
      results,
    })

    expect(out.map(r => r.metadata.id)).toContain('auto')
    expect(record.autoKept).toBeGreaterThanOrEqual(1)
  })

  it('Given gaps and insufficiency, then it issues bounded re-discovery and admits new facts', async () => {
    const results = [
      makeResult('seed', 'partial detail about caching'),
      ...Array.from({ length: 14 }, (_, i) => makeResult(`o-${i}`, `off topic ${i}`)),
    ]
    // Round 1: keep seed, report a gap, not sufficient. Round 2: keep the rediscovered fact.
    const llm = verdictLlm(
      { keep: ['seed'], gaps: ['cache eviction policy'], sufficient: false },
      { keep: ['found-1'], gaps: [], sufficient: true }
    )
    const requery: CuratorRequery = vi.fn(async () => [
      makeResult('found-1', 'cache eviction uses LRU policy'),
    ])

    const { results: out, record } = await curateFacts({
      llm,
      query: 'how does caching work',
      results,
      requery,
    })

    expect(record.requeried).toContain('cache eviction policy')
    expect(record.added).toBe(1)
    expect(out.map(r => r.metadata.id)).toContain('found-1')
    expect(out.map(r => r.metadata.id)).toContain('seed')
  })

  it('Given the LLM throws, then it fails safe and returns the original set untouched', async () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const { results: out, record } = await curateFacts({
      llm: errorLlm(),
      query: 'anything',
      results,
    })
    expect(out).toBe(results)
    expect(record.fellBack).toBe(true)
    expect(record.dropped).toHaveLength(0)
  })

  it('Given the judge drops everything, then it guards against an empty set via deterministic top-K', async () => {
    const results = Array.from({ length: 16 }, (_, i) =>
      makeResult(`f-${i}`, `query topic detail ${i}`)
    )
    const llm = verdictLlm({ keep: [], gaps: [], sufficient: false })

    const { results: out, record } = await curateFacts({
      llm,
      // Low overlap so nothing is auto-kept, forcing the empty-set guard.
      query: 'zzz nonmatching',
      results,
    })

    expect(out.length).toBeGreaterThan(0)
    expect(record.fellBack).toBe(true)
  })

  it('Given re-discovery returns only known ids, then it stops without looping', async () => {
    const results = [
      makeResult('seed', 'partial detail'),
      ...Array.from({ length: 14 }, (_, i) => makeResult(`o-${i}`, `off topic ${i}`)),
    ]
    const llm = verdictLlm({ keep: ['seed'], gaps: ['more detail'], sufficient: false })
    // Re-discovery returns a fact already in the pool → no new admissions, loop must end.
    const requery: CuratorRequery = vi.fn(async () => [makeResult('seed', 'partial detail')])

    const { record } = await curateFacts({
      llm,
      query: 'topic',
      results,
      requery,
    })

    expect(record.added).toBe(0)
    expect(record.rounds).toBe(1)
  })
})
