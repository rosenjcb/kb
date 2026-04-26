import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { SubmitOrchestrator, inferDomainFromFact } from '../../src/tools/submit-orchestrator'

function makeExecutor(overrides?: Partial<Record<string, unknown>>): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async (toolUse: { name: string }) => {
      if (overrides && toolUse.name in overrides) return overrides[toolUse.name]
      if (toolUse.name === 'upsert_fact') return { id: 'fact-1234', operation: 'inserted' }
      if (toolUse.name === 'upsert_graph_from_text') {
        return { enabled: true, entities: 1, relationships: 1 }
      }
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
    expect((result.result as { graphSync?: { entities?: number } }).graphSync?.entities).toBe(1)

    const upsertCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_fact'
    )
    expect(upsertCall?.[0].input.sourceKind).toBe('submit')
    expect(upsertCall?.[0].input.factText).toContain('QueryResearchOrchestrator')
    expect(
      (executor.execute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'upsert_graph_from_text'
      )
    ).toBe(true)
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

  it('Given graph sync still runs after upsert_fact', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async (toolUse: { name: string }) => {
        if (toolUse.name === 'upsert_fact') return { id: 'general-fact' }
        if (toolUse.name === 'upsert_graph_from_text') return { enabled: true, entities: 2 }
        return {}
      }),
    }

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'some new fact', source: 'consumer' })

    expect(result.targetDocId).toBe('general-fact')
    expect((result.result as { graphSync?: { entities?: number } }).graphSync?.entities).toBe(2)
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
