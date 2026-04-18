import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { validateFact } from '../../src/intents/evaluator'

function createExecutorWithRetrieval(retrieval: {
  method?: string
  detail?: string
}): ToolExecutor {
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

  it('Given shallow retrieval has no results and deep retrieval finds support, then validate promotes to deep and returns valid', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async toolUse => {
        if (toolUse.name !== 'read_documents') return { results: [], total: 0 }

        const depth = toolUse.input.discoveryDepth as string | undefined
        if (depth === 'shallow') {
          return {
            results: [],
            total: 0,
            retrieval: { method: 'hybrid', detail: 'shallow' },
          }
        }

        return {
          results: [
            {
              metadata: { id: 'config-facts' },
              content: 'The app commits .env.local in this repo policy.',
            },
          ],
          total: 1,
          retrieval: { method: 'hybrid', detail: 'deep' },
        }
      }),
    }

    const result = await validateFact(executor, '.env.local is committed in this repo policy')

    expect(result.status).toBe('valid')
    expect(result.explanation).toContain('deep evidence discovery')
    expect(result.provenance).toContain('config-facts')

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]?.input?.discoveryDepth).toBe('shallow')
    expect(calls[1][0]?.input?.discoveryDepth).toBe('deep')
  })

  it('Given relevant but non-supporting evidence, then validate returns uncertain with query_truth action', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async toolUse => {
        if (toolUse.name !== 'read_documents') return { results: [], total: 0 }
        return {
          results: [
            {
              metadata: { id: 'ops-facts' },
              content: 'Deployments require feature flag X and release checklist Y.',
            },
          ],
          total: 1,
          retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        }
      }),
    }

    const result = await validateFact(executor, 'incident review board meets every Friday')

    expect(result.status).toBe('uncertain')
    expect(result.recommendedAction).toBe('query_truth')
    expect(result.explanation).toContain('support is inconclusive')
  })
})
