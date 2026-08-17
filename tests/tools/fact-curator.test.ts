import { describe, expect, it, vi } from 'vitest'
import type { RunCollector } from '@kb/core/core/telemetry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import {
  type CuratorRequery,
  curateFacts,
  parseVerdict,
  shouldCurate,
} from '@kb/core/tools/fact-curator.js'
import type { QueryResult } from '@kb/core/tools/facts-document-reader.js'

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
    name: 'test-provider',
    model: 'test-model',
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
  it('[TC-3UN8] Given more than the threshold of results, then returns true', () => {
    const results = Array.from({ length: 13 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldCurate(results)).toBe(true)
  })

  it('[TC-KLE3] Given few results, then returns false', () => {
    const results = Array.from({ length: 8 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    expect(shouldCurate(results)).toBe(false)
  })
})

describe('parseVerdict', () => {
  it('[TC-NACU] Given a JSON object embedded in prose, then it extracts keep/gaps/sufficient', () => {
    const v = parseVerdict('Sure: {"keep":["a","b"],"gaps":["more"],"sufficient":true} done')
    expect([...v.keep]).toEqual(['a', 'b'])
    expect(v.gaps).toEqual(['more'])
    expect(v.sufficient).toBe(true)
  })

  it('[TC-OE63] Given no JSON, then it throws', () => {
    expect(() => parseVerdict('no json here')).toThrow()
  })
})

describe('curateFacts', () => {
  it('[TC-HEXQ] Given irrelevant facts, then the judge hard-drops them below the old 15% floor', async () => {
    // 20 facts; only 2 are on-topic. The old filter would refuse to drop below ~3.
    const results = [
      makeResult('keep-1', 'authentication token rotation'),
      makeResult('keep-2', 'authentication session expiry'),
      ...Array.from({ length: 18 }, (_, i) =>
        makeResult(`junk-${i}`, `rendering frame buffer ${i}`)
      ),
    ]
    const llm = verdictLlm({ keep: ['keep-1', 'keep-2'], gaps: [], sufficient: true })

    const { results: out, record } = await curateFacts({
      llm,
      query: 'how does authentication work',
      results,
      // Isolate judge hard-drop behavior from rank auto-keep / soft minKeep floor.
      options: { rankAutoKeep: 0, minKeep: 2 },
    })

    expect(out.map(r => r.metadata.id).sort()).toEqual(['keep-1', 'keep-2'])
    expect(record.dropped).toHaveLength(18)
    expect(record.sufficient).toBe(true)
  })

  it('[TC-B147] Given high token overlap, then a fact is auto-kept even if the judge omits it', async () => {
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

  it('[TC-MI89] Given gaps and insufficiency, then it issues bounded re-discovery and admits new facts', async () => {
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

  it('[TC-MZQY] Given the LLM throws, then it fails safe and returns the original set untouched', async () => {
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

  it('[TC-LQFN] Given the judge drops everything, then it guards against an empty set via deterministic top-K', async () => {
    const results = Array.from({ length: 16 }, (_, i) =>
      makeResult(`f-${i}`, `query topic detail ${i}`)
    )
    const llm = verdictLlm({ keep: [], gaps: [], sufficient: false })

    const { results: out, record } = await curateFacts({
      llm,
      // Low overlap so nothing is auto-kept, forcing the empty-set guard.
      query: 'zzz nonmatching',
      results,
      options: { rankAutoKeep: 0, minKeep: 5 },
    })

    expect(out.length).toBeGreaterThan(0)
    // Soft minKeep floor rescues ranked facts without the empty-set fellBack path.
    expect(out.length).toBeGreaterThanOrEqual(5)
    expect(record.fellBack).toBe(false)
  })

  it('[TC-AGUM] Given a pool larger than the judge candidate cap, then the tail is hard-dropped and the judge sees at most the cap', async () => {
    // 130 low-overlap facts → all candidates (none auto-kept), exceeding the default cap of 100.
    const results = Array.from({ length: 130 }, (_, i) =>
      makeResult(`f-${i}`, `unrelated topic ${i}`)
    )
    const call = vi.fn(async () => ({
      text: JSON.stringify({ keep: ['f-0', 'f-1'], gaps: [], sufficient: true }),
      stopReason: 'end_turn' as const,
      toolUses: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }))
    const llm = { call } as unknown as LLMProvider

    const { record } = await curateFacts({
      llm,
      query: 'alpha beta gamma',
      results,
      options: { rankAutoKeep: 0, minKeep: 2 },
    })

    // The judge prompt lists at most `maxJudgeCandidates` (100) candidate id|summary lines.
    const prompt = call.mock.calls[0][0].messages[0].content as string
    const candidateIds = prompt.split('\n').filter(l => /^f-\d+\|/.test(l))
    expect(candidateIds.length).toBeLessThanOrEqual(100)
    // The 30 over-cap facts are recorded as dropped without ever reaching the judge.
    expect(record.dropped.filter(d => d.reason === 'beyond curator candidate cap')).toHaveLength(30)
    expect(record.fellBack).toBe(false)
  })

  it('[TC-W5NK] Given the LLM throws on an over-cap pool, then the fallback is bounded to the cap, not the full pool', async () => {
    const results = Array.from({ length: 250 }, (_, i) =>
      makeResult(`f-${i}`, `unrelated topic ${i}`)
    )
    const { results: out, record } = await curateFacts({
      llm: errorLlm(),
      query: 'alpha beta gamma',
      results,
      options: { maxJudgeCandidates: 40 },
    })
    expect(record.fellBack).toBe(true)
    // Never dump the full 250-fact pool into synthesis — bound it to the cap.
    expect(out.length).toBe(40)
  })

  it('[TC-R5W9] Given re-discovery returns only known ids, then it stops without looping', async () => {
    const results = [
      makeResult('seed', 'partial detail about caching'),
      ...Array.from({ length: 14 }, (_, i) => makeResult(`o-${i}`, `unrelated rendering ${i}`)),
    ]
    const llm = verdictLlm({ keep: ['seed'], gaps: ['more detail'], sufficient: false })
    // Re-discovery returns a fact already in the pool → no new admissions, loop must end.
    const requery: CuratorRequery = vi.fn(async () => [
      makeResult('seed', 'partial detail about caching'),
    ])

    const { record } = await curateFacts({
      llm,
      query: 'cache eviction policy',
      results,
      requery,
      options: { rankAutoKeep: 0, minKeep: 1 },
    })

    expect(record.added).toBe(0)
    expect(record.rounds).toBe(1)
  })

  it('[TC-F3JM] Given rank auto-keep, then top-N incoming facts survive even when the judge keeps nothing', async () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult(`f-${i}`, `unrelated rendering buffer ${i}`)
    )
    const llm = verdictLlm({ keep: [], gaps: [], sufficient: true })

    const { results: out, record } = await curateFacts({
      llm,
      query: 'zzz nonmatching query',
      results,
      options: { rankAutoKeep: 10, minKeep: 10 },
    })

    expect(record.autoKept).toBeGreaterThanOrEqual(10)
    expect(out.map(r => r.metadata.id).slice(0, 10)).toEqual(
      results.slice(0, 10).map(r => r.metadata.id)
    )
    expect(out.length).toBeGreaterThanOrEqual(10)
  })

  it('[TC-VZ2O] Given a collector, then each judge round is recorded as a telemetry stage', async () => {
    const results = [
      makeResult('seed', 'partial detail about caching'),
      ...Array.from({ length: 14 }, (_, i) => makeResult(`o-${i}`, `off topic ${i}`)),
    ]
    const llm = verdictLlm(
      { keep: ['seed'], gaps: ['cache eviction policy'], sufficient: false },
      { keep: ['found-1'], gaps: [], sufficient: true }
    )
    const requery: CuratorRequery = vi.fn(async () => [
      makeResult('found-1', 'cache eviction uses LRU policy'),
    ])
    const addStage = vi.fn()
    const collector = { addStage } as unknown as RunCollector

    await curateFacts({
      llm,
      query: 'how does caching work',
      results,
      requery,
      collector,
    })

    expect(addStage).toHaveBeenCalledTimes(2)
    expect(addStage.mock.calls[0][0]).toMatchObject({
      stage: 'fact-curator:judge:round1',
      inputTokens: 10,
      outputTokens: 5,
      provider: 'test-provider',
      model: 'test-model',
    })
    expect(addStage.mock.calls[1][0]).toMatchObject({
      stage: 'fact-curator:judge:round2',
      inputTokens: 10,
      outputTokens: 5,
    })
  })
})

describe('curator degradation reporting', () => {
  it('[TC-NIJ2] Given the LLM throws, then the record carries why it fell back so the outage is attributable', async () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult(`f-${i}`, `fact ${i}`))
    const { record } = await curateFacts({
      llm: {
        name: 'anthropic',
        model: 'stub',
        call: async () => {
          throw new Error('[anthropic] API request failed (429): rate limited')
        },
      } as unknown as LLMProvider,
      query: 'anything',
      results,
    })
    expect(record.fellBack).toBe(true)
    expect(record.failure?.kind).toBe('rate_limit')
    expect(record.failure?.stage).toBe('curation')
  })
})
