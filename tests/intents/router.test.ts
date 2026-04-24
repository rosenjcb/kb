import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { DefaultIntentRouter } from '../../src/intents/router'

function createExecutorMock(): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async toolUse => {
      if (toolUse.name === 'read_documents') {
        return {
          results: [
            {
              metadata: { id: 'ops-facts' },
              content: 'Deployments require feature flag X.',
            },
          ],
          total: 1,
          retrieval: { method: 'hybrid' },
        }
      }
      if (toolUse.name === 'write_document') {
        return { id: 'new-doc' }
      }
      if (toolUse.name === 'append_to_document') {
        return { id: 'existing-doc' }
      }
      if (toolUse.name === 'reconcile_contradictions') {
        return {
          changedDocumentIds: ['general-facts'],
          changedDocs: 1,
          scannedDocs: 2,
          removedFacts: 2,
        }
      }
      if (toolUse.name === 'upsert_graph_from_text') {
        return { enabled: true, entities: 1, relationships: 1 }
      }
      if (toolUse.name === 'invalidate_fact') {
        return {
          changes: [{ documentId: 'ops-facts', title: 'Ops Facts', replaced: 1, diff: '- old\n+ new' }],
          summary: 'Scanned 3 KB documents. 1 replacements in 1 documents.',
        }
      }
      if (toolUse.name === 'invalidate_graph_documents') {
        return { enabled: true, invalidatedRelationships: 3, documentIds: ['ops-facts'] }
      }
      return { ok: true }
    }),
  }
}

describe('DefaultIntentRouter', () => {
  it('Given submit_fact, then routes to submit_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Some fact',
        domain: 'operations',
      },
    })

    expect(decision.selectedOperation).toBe('submit_orchestrator')
  })

  it('Given submit_fact, then execute runs contradiction reconciliation after submission', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'submit_fact',
      payload: {
        fact: 'Canonical term renamed',
      },
    })

    expect(result.status).toBe('accepted')
    expect(result.recommendedAction).toBe('reconcile_contradictions')
    const data = result.data as {
      submission?: { graphSync?: { entities?: number } }
      contradictionReconciliation?: { changedDocs?: number; removedFacts?: number }
    }
    expect(data.submission?.graphSync?.entities).toBe(1)
    expect(data.contradictionReconciliation?.removedFacts).toBe(2)

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some(call => call[0]?.name === 'upsert_graph_from_text')).toBe(true)
    expect(calls.some(call => call[0]?.name === 'reconcile_contradictions')).toBe(true)
  })

  it('Given inferred domain doc missing, execute falls back from append_to_document to write_document', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async toolUse => {
        if (toolUse.name === 'read_documents') {
          return { results: [], retrieval: { method: 'lexical-fallback' } }
        }
        if (toolUse.name === 'append_to_document') {
          throw new Error('Document not found: operations-facts')
        }
        if (toolUse.name === 'write_document') {
          return { id: 'operations-facts' }
        }
        if (toolUse.name === 'upsert_graph_from_text') {
          return { enabled: true, entities: 0, relationships: 0 }
        }
        if (toolUse.name === 'reconcile_contradictions') {
          return { changedDocumentIds: [], removedFacts: 0 }
        }
        return { ok: true }
      }),
    }

    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'submit_fact',
      payload: {
        fact: 'Ops fallback create test',
        domain: 'operations',
      },
    })

    expect(result.status).toBe('accepted')
    expect(result.recommendedAction).toBe('reconcile_contradictions')

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    const names = calls.map((c: unknown[]) => (c[0] as { name?: string })?.name)
    expect(names).toContain('write_document')
    expect(names.indexOf('append_to_document')).toBeLessThan(names.indexOf('write_document'))
  })

  it('Given invalidate_fact, then routes to invalidate_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'invalidate_fact',
      payload: { oldFact: 'feature flag X' },
    })

    expect(decision.selectedOperation).toBe('invalidate_orchestrator')
  })

  it('Given invalidate_fact without preview, then execute invalidates graph provenance too', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'invalidate_fact',
      payload: { oldFact: 'feature flag X' },
    })

    expect(result.status).toBe('accepted')
    expect(result.provenance).toContain('ops-facts')

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some(call => call[0]?.name === 'invalidate_fact')).toBe(true)
    expect(calls.some(call => call[0]?.name === 'invalidate_graph_documents')).toBe(true)
  })

  it('Given invalidate_fact with preview, then skips graph invalidation', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'invalidate_fact',
      payload: { oldFact: 'feature flag X', preview: true },
    })

    expect(result.status).toBe('accepted')
    expect(result.recommendedAction).toBe('preview_invalidation')

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some(call => call[0]?.name === 'invalidate_fact')).toBe(true)
    expect(calls.every(call => call[0]?.name !== 'invalidate_graph_documents')).toBe(true)
  })

  it('Given query_truth without discoveryDepth, then defaults to deep discovery like chat', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'how does hybrid retrieval work in kb',
      },
    })

    expect(decision.selectedOperation).toBe('read_documents')
    expect(decision.operationInput.discoveryDepth).toBe('deep')
  })

  it('Given query_truth with high-recall token query, then auto-promotes to wider limit', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'query-research-orchestrator',
      },
    })

    expect(decision.selectedOperation).toBe('read_documents')
    expect(decision.operationInput.limit).toBeGreaterThanOrEqual(12)
  })
})
