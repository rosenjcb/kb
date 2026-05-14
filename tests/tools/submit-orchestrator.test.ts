import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMCallParams, LLMProvider } from '../../src/core/types'
import { SubmitOrchestrator, inferDomainFromFact } from '../../src/tools/submit-orchestrator'

function mockLlm(triplets: Array<{ subject: string; predicate: string; object: string }>): LLMProvider {
  return {
    call: async () => ({ text: JSON.stringify(triplets), inputTokens: 0, outputTokens: 0 }),
  } as unknown as LLMProvider
}

function makeExecutor(overrides?: Partial<Record<string, unknown>>): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async (toolUse: { name: string }) => {
      if (overrides && toolUse.name in overrides) return overrides[toolUse.name]
      if (toolUse.name === 'upsert_fact') return { id: 'fact-1234', operation: 'inserted' }
      return { ok: true }
    }),
  }
}

describe('SubmitOrchestrator', () => {
  it('Given submitted fact, then upserts canonical fact and syncs graph', async () => {
    const executor = makeExecutor()

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'QueryResearchOrchestrator seeds hypotheses in parallel',
      source: 'consumer',
    })

    expect(result.discoveredTarget).toBe(false)
    expect(result.targetDocId).toBe('fact-1234')
    expect(result.operation).toBe('fact_upserted')

    const upsertCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_fact'
    )
    expect(upsertCall?.[0].input.sourceKind).toBe('submit')
    expect(upsertCall?.[0].input.factText).toContain('QueryResearchOrchestrator')
  })

  it('Given domain-like fact, then graph source id is fact id', async () => {
    const executor = makeExecutor({ upsert_fact: { id: 'retrieval-fact', operation: 'inserted' } })

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'vector embedding index uses FTS5 for hybrid search',
      source: 'consumer',
    })

    expect(result.targetDocId).toBe('retrieval-fact')
  })

  it('Given no special executor behavior, then still returns fact_upserted result', async () => {
    const executor = makeExecutor()

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'deploy pipeline triggers on main branch push',
      source: 'consumer',
    })

    expect(result.discoveredTarget).toBe(false)
    expect(result.operation).toBe('fact_upserted')
  })

  it('multi-fact input calls upsert_fact once per triplet', async () => {
    const executor = makeExecutor()
    const llm = mockLlm([
      { subject: 'TsMorphIndexer', predicate: 'handles', object: 'TypeScript files' },
      { subject: 'TreeSitterIndexer', predicate: 'handles', object: 'Go files' },
    ])

    const orchestrator = new SubmitOrchestrator(executor, llm)
    const result = await orchestrator.run({
      fact: 'TsMorphIndexer handles TypeScript files and TreeSitterIndexer handles Go files',
      source: 'consumer',
    })

    expect(result.operation).toBe('fact_upserted')
    const upsertCalls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_fact'
    )
    expect(upsertCalls).toHaveLength(2)
    expect(upsertCalls[0]?.[0].input.triplet.subject).toBe('TsMorphIndexer')
    expect(upsertCalls[1]?.[0].input.triplet.subject).toBe('TreeSitterIndexer')
  })

  it('upsert_fact is called exactly once for single-fact input', async () => {
    const executor = makeExecutor()

    const orchestrator = new SubmitOrchestrator(executor)
    await orchestrator.run({ fact: 'A uses B', source: 'consumer' })

    const upsertCalls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_fact'
    )
    expect(upsertCalls).toHaveLength(1)
  })

  it('input with more than 5 sentences is split into multiple LLM chunks', async () => {
    const callContents: string[] = []
    const llm: LLMProvider = {
      call: async (params: LLMCallParams) => {
        const content = params.messages[0]?.content
        callContents.push(typeof content === 'string' ? content : '')
        return { text: '[{"subject":"X","predicate":"does","object":"Y"}]', inputTokens: 0, outputTokens: 0 }
      },
    } as unknown as LLMProvider

    const executor = makeExecutor()
    const orchestrator = new SubmitOrchestrator(executor, llm)
    // 6 sentences → chunks of 5 + 1 → 2 LLM calls
    await orchestrator.run({
      fact: 'A does X. B does Y. C does Z. D does W. E does V. F does U.',
      source: 'consumer',
    })

    expect(callContents).toHaveLength(2)
    expect(callContents[0]).toContain('A does X')
    expect(callContents[1]).toContain('F does U')
    const upsertCalls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_fact'
    )
    expect(upsertCalls).toHaveLength(2)
  })

  it('throws on empty fact text', async () => {
    const orchestrator = new SubmitOrchestrator(makeExecutor())
    await expect(orchestrator.run({ fact: '   ', source: 'consumer' })).rejects.toThrow('empty')
  })

})

describe('inferDomainFromFact', () => {
  it('matches cicd for deploy keywords', () => {
    expect(inferDomainFromFact('deploy pipeline triggers on main')).toBe('cicd')
  })

  it('matches retrieval for search/vector keywords', () => {
    expect(inferDomainFromFact('vector embedding index for hybrid search')).toBe('retrieval')
  })

  it('matches security for auth keywords', () => {
    expect(inferDomainFromFact('oauth token rotation every 24 hours')).toBe('security')
  })

  it('falls back to general for unknown content', () => {
    expect(inferDomainFromFact('the quick brown fox jumped')).toBe('general')
  })
})
