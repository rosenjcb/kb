import { describe, expect, it, vi } from 'vitest'
import { executeChatQueryTruthRetrieval } from '../../src/cli/chat-query-orchestrator'
import type { ToolExecutor } from '../../src/core/tool-registry'
import { isReadDocumentsResult } from '../../src/cli/intent-cli'

describe('chat-query-orchestrator', () => {
  it('Given a mocked read_documents result, then returns accepted read_documents IntentResult', async () => {
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
      workspaceDir: '/tmp',
    })

    expect(isReadDocumentsResult(result)).toBe(true)
    expect(result.explanation).toContain('read_documents')
    expect(executor.execute).toHaveBeenCalled()
  })
})
