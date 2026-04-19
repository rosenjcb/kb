import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { ExplainOrchestrator } from '../../src/tools/explain-orchestrator'

function makeExecutor(responses: unknown[]): ToolExecutor {
  const execute = vi.fn()
  for (const r of responses) execute.mockResolvedValueOnce(r)
  execute.mockResolvedValue({ results: [], total: 0, retrieval: { method: 'lexical-fallback' } })
  return { register: vi.fn(), getTools: vi.fn(() => []), execute }
}

const hit = (id: string) => ({ metadata: { id }, content: `Content of ${id}.` })

describe('ExplainOrchestrator', () => {
  it('Given ID-first probe returns results, stops immediately and returns them', async () => {
    const executor = makeExecutor([
      { results: [hit('query-research-orchestrator')], total: 1, retrieval: { method: 'hybrid' } },
    ])

    const orchestrator = new ExplainOrchestrator(executor)
    const result = await orchestrator.run({ changeId: 'query-research-orchestrator' })

    expect(result.results.length).toBe(1)
    expect(result.results[0].metadata?.id).toBe('query-research-orchestrator')
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('Given ID-first returns nothing, falls back to shallow semantic search', async () => {
    const executor = makeExecutor([
      { results: [], total: 0, retrieval: { method: 'lexical-fallback' } },
      {
        results: [hit('arch-doc-1'), hit('arch-doc-2')],
        total: 2,
        retrieval: { method: 'hybrid' },
      },
    ])

    const orchestrator = new ExplainOrchestrator(executor)
    const result = await orchestrator.run({ changeId: 'hypothesis-driven retrieval architecture' })

    expect(result.results.length).toBe(2)
    expect(executor.execute).toHaveBeenCalledTimes(2)
    const secondCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondCall.input.mode).toBe('content')
  })

  it('Given shallow returns only 1 result, escalates to deep for completeness', async () => {
    const executor = makeExecutor([
      { results: [], total: 0, retrieval: { method: 'lexical-fallback' } },
      { results: [hit('doc-a')], total: 1, retrieval: { method: 'hybrid' } },
      { results: [hit('doc-a'), hit('doc-b')], total: 2, retrieval: { method: 'hybrid', detail: 'research-orchestrator' } },
    ])

    const orchestrator = new ExplainOrchestrator(executor)
    const result = await orchestrator.run({ changeId: 'some complex concept' })

    expect(result.results.length).toBe(2)
    expect(executor.execute).toHaveBeenCalledTimes(3)
    const deepCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[2][0]
    expect(deepCall.input.discoveryDepth).toBe('deep')
  })

  it('Given all probes return nothing, returns empty result without throwing', async () => {
    const executor = makeExecutor([])

    const orchestrator = new ExplainOrchestrator(executor)
    const result = await orchestrator.run({ changeId: 'nonexistent concept' })

    expect(result.results).toHaveLength(0)
    expect(result.retrieval.method).toBeDefined()
  })

  it('Given read_documents throws, returns empty result without rethrowing', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => { throw new Error('timeout') }),
    }

    const orchestrator = new ExplainOrchestrator(executor)
    const result = await orchestrator.run({ changeId: 'anything' })

    expect(result.results).toHaveLength(0)
    expect(result.retrieval.method).toBe('error')
  })
})
