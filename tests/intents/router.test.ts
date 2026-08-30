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
  it('[TC-Z1H5] Given query_truth without discoveryDepth, then defaults to deep discovery like chat', async () => {
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

  it('[TC-GTAJ] Given query_truth with high-recall token query, then uses default limit without floor', async () => {
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

  it('[TC-AX85] Given query_truth without explicit limit, then defaults to DEFAULT_FACT_LIMIT facts', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'how does hybrid retrieval work in kb',
      },
    })

    expect(decision.operationInput.limit).toBe(40)
  })

  it('[TC-HZOB] Given a collector passed to the constructor, then query_truth operationInput carries it through', async () => {
    const executor = createExecutorMock()
    const collector = { addStage: vi.fn() } as unknown as import('@kb/core/core/telemetry.js').RunCollector
    const router = new DefaultIntentRouter(executor, undefined, undefined, collector)

    const decision = await router.route({
      intent: 'query_truth',
      payload: { query: 'how does hybrid retrieval work in kb' },
    })

    expect(decision.operationInput.collector).toBe(collector)
  })

  it('[TC-XH9F] Given a read_facts result with one hit and no checkpoints, then evidence is weak', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    // The mock's read_facts result has exactly 1 result and no retrieval.checkpoints.
    const result = await router.execute({
      intent: 'query_truth',
      payload: { query: 'how does hybrid retrieval work in kb' },
    })

    expect(result.evidence).toBe('weak')
  })

  it('[TC-1YYY] Given a read_facts result with zero results and no checkpoints, then evidence is none, not strong', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({ results: [], total: 0, retrieval: { method: 'hybrid' } })),
    }
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'query_truth',
      payload: { query: 'anything' },
    })

    expect(result.evidence).toBe('none')
  })

  it('[TC-4GBT] Given three read_facts hits and no checkpoints, then evidence is moderate, not strong', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        results: [
          { metadata: { id: 'a' }, content: 'one' },
          { metadata: { id: 'b' }, content: 'two' },
          { metadata: { id: 'c' }, content: 'three' },
        ],
        total: 3,
        retrieval: { method: 'hybrid' },
      })),
    }
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'query_truth',
      payload: { query: 'anything' },
    })

    expect(result.evidence).toBe('moderate')
  })
})
