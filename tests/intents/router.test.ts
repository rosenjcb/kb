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

  it('Given submit_fact without targetDocumentId, then routes to upsert_fact_document', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Some fact',
        domain: 'operations',
      },
    })

    expect(decision.selectedOperation).toBe('upsert_fact_document')
    expect(decision.operationInput.documentId).toBe('operations-facts')
  })

  it('Given submit_fact without explicit domain and CI/CD wording, then infers cicd domain', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Our GitHub Actions pipeline deploys on merge to main.',
      },
    })

    expect(decision.selectedOperation).toBe('upsert_fact_document')
    expect(decision.operationInput.documentId).toBe('cicd-facts')
    expect(decision.operationInput.title).toBe('cicd facts')
    expect(decision.operationInput.tags).toEqual(['cicd', 'fact'])
  })

  it('Given custom classifier mapping, then submit_fact infers custom domain', async () => {
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

    expect(decision.selectedOperation).toBe('upsert_fact_document')
    expect(decision.operationInput.documentId).toBe('platform-facts')
    expect(decision.operationInput.title).toBe('platform facts')
    expect(decision.operationInput.tags).toEqual(['platform', 'fact'])

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
    expect(calls[0][0]?.name).toBe('append_to_document')
    expect(calls[1][0]?.name).toBe('write_document')
  })

  it('Given validate_fact, then returns valid status with provenance', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'validate_fact',
      payload: {
        fact: 'feature flag X',
      },
    })

    expect(result.status).toBe('valid')
    expect(result.provenance).toContain('ops-facts')
  })

  it('Given dispute_fact missing because, then returns invalid payload error', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const result = await router.execute({
      intent: 'dispute_fact',
      payload: {
        fact: 'feature flag X',
      },
    })

    expect(result.status).toBe('error')
    expect(result.errorCode).toBe('INVALID_PAYLOAD')
  })

  it('Given explain_change with natural language prompt, then routes to read_documents auto mode with semantic fallback', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'explain_change',
      payload: {
        fact: 'how vector search works with doc retrieval in kb',
      },
    })

    expect(decision.selectedOperation).toBe('read_documents')
    expect(decision.operationInput.query).toBe('how vector search works with doc retrieval in kb')
    expect(decision.operationInput.includeContent).toBe(true)
    expect(decision.operationInput.limit).toBe(3)
    expect(decision.operationInput.mode).toBeUndefined()
  })
})
