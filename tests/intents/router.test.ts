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
          proposedDiffs: [
            {
              documentId: 'general-facts',
              filePath: '/tmp/general-facts.md',
              replacements: 2,
              diff: '--- a/tmp/general-facts.md\n+++ b/tmp/general-facts.md',
            },
          ],
        }
      }
      return { ok: true }
    }),
  }
}

describe('DefaultIntentRouter', () => {
  it('Given submit_fact with targetDocumentId, then routes to append_to_document', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Some fact',
        targetDocumentId: 'ops-facts',
      },
    })

    expect(decision.selectedOperation).toBe('append_to_document')
  })

  it('Given submit_fact without targetDocumentId, then routes to submit_orchestrator', async () => {
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

  it('Given submit_fact without explicit domain and CI/CD wording, then routes to submit_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Our GitHub Actions pipeline deploys on merge to main.',
      },
    })

    expect(decision.selectedOperation).toBe('submit_orchestrator')
  })

  it('Given custom classifier mapping, then submit_fact routes to submit_orchestrator', async () => {
    process.env.KB_DOMAIN_CLASSIFIER = JSON.stringify({
      platform: ['platform api', 'control-plane'],
    })

    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'The platform API control-plane versioning policy changed.',
      },
    })

    expect(decision.selectedOperation).toBe('submit_orchestrator')

    delete process.env.KB_DOMAIN_CLASSIFIER
  })

  it('Given submit_fact, then execute automatically runs contradiction reconciliation', async () => {
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
      submission?: unknown
      contradictionReconciliation?: { changedDocs?: number; removedFacts?: number }
    }
    expect(data.contradictionReconciliation?.changedDocs).toBe(1)
    expect(data.contradictionReconciliation?.removedFacts).toBe(2)

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some(call => call[0]?.name === 'reconcile_contradictions')).toBe(true)
    const reconcileCall = calls.find(call => call[0]?.name === 'reconcile_contradictions')
    expect(reconcileCall?.[0]?.input?.newFact).toBe('Canonical term renamed')
  })

  it('Given inferred domain doc missing, execute falls back from append_to_document to write_document', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async toolUse => {
        if (toolUse.name === 'read_documents') {
          // No hybrid hit → orchestrator falls through to domain fallback
          return { results: [], retrieval: { method: 'lexical-fallback' } }
        }
        if (toolUse.name === 'append_to_document') {
          throw new Error('Document not found: operations-facts')
        }
        if (toolUse.name === 'write_document') {
          return { id: 'operations-facts' }
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

  it('Given validate_fact, then routes to validate_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'validate_fact',
      payload: { fact: 'feature flag X' },
    })

    expect(decision.selectedOperation).toBe('validate_orchestrator')
  })

  it('Given validate_fact execute, then returns valid status with provenance via orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'validate_fact',
      payload: { fact: 'feature flag X' },
    })

    expect(result.status).toBe('valid')
    expect(result.provenance).toContain('ops-facts')
  })

  it('Given explain_change with natural language prompt, then routes to explain_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'explain_change',
      payload: {
        fact: 'how vector search works with doc retrieval in kb',
      },
    })

    expect(decision.selectedOperation).toBe('explain_orchestrator')
  })

  it('Given query_truth with discoveryDepth deep, then routes to read_documents with discovery depth', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'env local commit policy',
        discoveryDepth: 'deep',
      },
    })

    expect(decision.selectedOperation).toBe('read_documents')
    expect(decision.operationInput.discoveryDepth).toBe('deep')
  })

  it('Given query_truth with high-recall token query, then auto-promotes to deep discovery and wider limit', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'query_truth',
      payload: {
        query: 'CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION',
      },
    })

    expect(decision.selectedOperation).toBe('read_documents')
    expect(decision.operationInput.discoveryDepth).toBe('deep')
    expect(decision.operationInput.limit).toBe(12)
  })

  it('Given explain_change with high-recall token query, then routes to explain_orchestrator', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'explain_change',
      payload: {
        fact: 'CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION',
      },
    })

    expect(decision.selectedOperation).toBe('explain_orchestrator')
  })
})
