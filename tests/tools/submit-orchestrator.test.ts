import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { SubmitOrchestrator, inferDomainFromFact } from '../../src/tools/submit-orchestrator'

function makeExecutor(overrides?: Partial<Record<string, unknown>>): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async (toolUse: { name: string }) => {
      if (overrides && toolUse.name in overrides) return overrides[toolUse.name]
      if (toolUse.name === 'read_documents') {
        return { results: [], retrieval: { method: 'lexical-fallback' } }
      }
      if (toolUse.name === 'append_to_document') return { id: 'appended-doc' }
      if (toolUse.name === 'write_document') return { id: 'new-doc' }
      if (toolUse.name === 'upsert_graph_from_text') {
        return { enabled: true, entities: 1, relationships: 1 }
      }
      return { ok: true }
    }),
  }
}

describe('SubmitOrchestrator', () => {
  it('Given hybrid read_documents hit, then appends to the discovered doc', async () => {
    const executor = makeExecutor({
      read_documents: {
        results: [{ metadata: { id: 'query-research-orchestrator' } }],
        retrieval: { method: 'hybrid' },
      },
    })

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'QueryResearchOrchestrator seeds hypotheses in parallel',
      source: 'consumer',
    })

    expect(result.discoveredTarget).toBe(true)
    expect(result.targetDocId).toBe('query-research-orchestrator')
    expect(result.operation).toBe('appended')
    expect((result.result as { graphSync?: { entities?: number } }).graphSync?.entities).toBe(1)

    const appendCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [{ name: string }]) => c[0].name === 'append_to_document'
    )
    expect(appendCall?.[0].input.documentId).toBe('query-research-orchestrator')
    expect(
      (executor.execute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: [{ name: string }]) => c[0].name === 'upsert_graph_from_text'
      )
    ).toBe(true)
  })

  it('Given lexical-fallback result, then falls back to domain-facts instead', async () => {
    const executor = makeExecutor({
      read_documents: {
        results: [{ metadata: { id: 'some-doc' } }],
        retrieval: { method: 'lexical-fallback' },
      },
    })

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'vector embedding index uses FTS5 for hybrid search',
      source: 'consumer',
    })

    expect(result.discoveredTarget).toBe(false)
    expect(result.targetDocId).toBe('retrieval-facts')
  })

  it('Given no read_documents results, then falls back to domain-inferred doc', async () => {
    const executor = makeExecutor({
      read_documents: { results: [], retrieval: { method: 'hybrid' } },
    })

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({
      fact: 'deploy pipeline triggers on main branch push',
      source: 'consumer',
    })

    expect(result.discoveredTarget).toBe(false)
    expect(result.targetDocId).toBe('cicd-facts')
  })

  it('Given read_documents throws, then falls back to domain-inferred doc without throwing', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async (toolUse: { name: string }) => {
        if (toolUse.name === 'read_documents') throw new Error('network error')
        if (toolUse.name === 'append_to_document') return { id: 'general-facts' }
        return { id: 'general-facts' }
      }),
    }

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'some new fact', source: 'consumer' })

    expect(result.discoveredTarget).toBe(false)
    expect(result.targetDocId).toBe('general-facts')
  })

  it('Given append_to_document throws on fallback, then write_document is used', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async (toolUse: { name: string }) => {
        if (toolUse.name === 'read_documents') {
          return { results: [], retrieval: { method: 'lexical-fallback' } }
        }
        if (toolUse.name === 'append_to_document') throw new Error('doc not found')
        if (toolUse.name === 'write_document') return { id: 'general-facts' }
        return {}
      }),
    }

    const orchestrator = new SubmitOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'some new fact', source: 'consumer' })

    expect(result.operation).toBe('upserted')
    const writeCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [{ name: string }]) => c[0].name === 'write_document'
    )
    expect(writeCall).toBeDefined()
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
