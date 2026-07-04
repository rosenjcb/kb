import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import { DefaultIntentRouter } from '@kb/core/intents/router.js'

function createExecutorMock(): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async toolUse => {
      if (toolUse.name === 'read_facts') {
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
      if (toolUse.name === 'upsert_fact') {
        return { id: 'test-fact-id', operation: 'inserted' }
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
      return { ok: true }
    }),
  }
}

describe('DefaultIntentRouter', () => {
  it('[TC-1] Given query_truth without discoveryDepth, then defaults to deep discovery like chat', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'how does hybrid retrieval work in kb',
      },
    })

    expect(decision.selectedOperation).toBe('read_facts')
    expect(decision.operationInput.discoveryDepth).toBe('deep')
  })

  it('[TC-2] Given query_truth with high-recall token query, then uses default limit without floor', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'query-research-orchestrator',
        limit: 12,
      },
    })

    expect(decision.selectedOperation).toBe('read_facts')
    expect(decision.operationInput.limit).toBe(12)
  })

  it('[TC-3] Given query_truth without explicit limit, then defaults to 500 facts', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'how does hybrid retrieval work in kb',
      },
    })

    expect(decision.operationInput.limit).toBe(500)
  })
})
