import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { ValidateOrchestrator } from '../../src/tools/validate-orchestrator'

function makeExecutor(readDocumentsResponse: unknown): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async () => readDocumentsResponse),
  }
}

describe('ValidateOrchestrator', () => {
  it('Given shallow hit with fact present in content, returns valid with high confidence', async () => {
    const executor = makeExecutor({
      results: [
        { metadata: { id: 'arch-doc' }, content: 'QueryResearchOrchestrator seeds hypotheses in parallel.' },
      ],
      retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
    })

    const orchestrator = new ValidateOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'QueryResearchOrchestrator seeds hypotheses in parallel' })

    expect(result.status).toBe('valid')
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    expect(result.provenance).toContain('arch-doc')
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('Given shallow returns nothing, escalates to deep probe', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ results: [], retrieval: { method: 'lexical-fallback' } })
      .mockResolvedValueOnce({
        results: [{ metadata: { id: 'deep-doc' }, content: 'hybrid search uses FTS5 and vector embeddings.' }],
        retrieval: { method: 'hybrid', detail: 'research-orchestrator' },
      })

    const executor: ToolExecutor = { register: vi.fn(), getTools: vi.fn(() => []), execute }

    const orchestrator = new ValidateOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'hybrid search uses FTS5' })

    expect(result.status).toBe('valid')
    expect(execute).toHaveBeenCalledTimes(2)
    const secondCall = execute.mock.calls[1][0]
    expect(secondCall.input.discoveryDepth).toBe('deep')
  })

  it('Given shallow returns docs but no semantic match, returns uncertain 0.45', async () => {
    const executor = makeExecutor({
      results: [
        { metadata: { id: 'unrelated-doc' }, content: 'Completely unrelated content about cooking recipes.' },
      ],
      retrieval: { method: 'hybrid' },
    })

    const orchestrator = new ValidateOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'kubernetes cluster autoscaling policy' })

    expect(result.status).toBe('uncertain')
    expect(result.confidence).toBe(0.45)
  })

  it('Given no docs found at all, returns uncertain 0.2 and recommends submit', async () => {
    const executor = makeExecutor({ results: [], retrieval: { method: 'lexical-fallback' } })

    const orchestrator = new ValidateOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'some completely unknown fact' })

    expect(result.status).toBe('uncertain')
    expect(result.confidence).toBe(0.2)
    expect(result.recommendedAction).toBe('submit_fact')
  })

  it('Given read_documents throws, returns uncertain without rethrowing', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => { throw new Error('network error') }),
    }

    const orchestrator = new ValidateOrchestrator(executor)
    const result = await orchestrator.run({ fact: 'anything' })

    expect(result.status).toBe('uncertain')
    expect(result.confidence).toBe(0.2)
  })

  it('Given domain provided, prefixes query with domain', async () => {
    const executor = makeExecutor({ results: [], retrieval: { method: 'lexical-fallback' } })

    const orchestrator = new ValidateOrchestrator(executor)
    await orchestrator.run({ fact: 'some fact', domain: 'retrieval' })

    const firstCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall.input.query).toBe('retrieval some fact')
  })
})
