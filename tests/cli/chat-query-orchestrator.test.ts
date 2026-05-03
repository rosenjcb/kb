import { describe, expect, it, vi } from 'vitest'
import { executeChatQueryTruthRetrieval } from '../../src/cli/chat-query-orchestrator'
import { isReadFactsResult } from '../../src/cli/intent-cli'
import type { ToolExecutor } from '../../src/core/tool-registry'

describe('chat-query-orchestrator', () => {
  it('Given a mocked read_facts result, then returns accepted read_facts IntentResult', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        results: [{ metadata: { id: 'doc-a' }, content: 'hello' }],
        retrieval: { method: 'hybrid', detail: 'x' },
      })),
    }

    const result = await executeChatQueryTruthRetrieval({
      toolExecutor: executor,
      expandedQuery: 'What is up?',
      retrievalLimit: 5,
    })

    expect(isReadFactsResult(result)).toBe(true)
    expect(result.explanation).toContain('read_facts')
    expect(executor.execute).toHaveBeenCalled()
  })
})
