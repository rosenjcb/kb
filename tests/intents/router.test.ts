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

  it('Given submit_fact without targetDocumentId, then routes to write_document', async () => {
    const executor = createExecutorMock()
    const router = new DefaultIntentRouter(executor)

    const decision = await router.route({
      intent: 'submit_fact',
      payload: {
        fact: 'Some fact',
        domain: 'operations',
      },
    })

    expect(decision.selectedOperation).toBe('write_document')
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
