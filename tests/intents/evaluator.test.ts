import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { validateFact } from '../../src/intents/evaluator'

function createExecutorWithRetrieval(
  retrieval: { method?: string; detail?: string },
): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async toolUse => {
      if (toolUse.name !== 'read_documents') return { results: [], total: 0 }

      return {
        results: [
          {
            metadata: { id: 'ops-facts' },
            content: 'Deployments require feature flag X.',
          },
        ],
        total: 1,
        retrieval,
      }
    }),
  }
}

describe('validateFact retrieval transparency', () => {
  it('Given read_documents retrieval metadata, then validate result includes retrieval method in explanation and data', async () => {
    const executor = createExecutorWithRetrieval({
      method: 'hybrid',
      detail: 'fts+vector-rerank',
    })

    const result = await validateFact(executor, 'feature flag X')

    expect(result.status).toBe('valid')
    expect(result.explanation).toContain('Retrieval method: hybrid (fts+vector-rerank).')
    expect((result.data as { retrieval?: { method?: string } })?.retrieval?.method).toBe('hybrid')
  })
})
