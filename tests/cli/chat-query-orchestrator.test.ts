import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeChatQueryTruthRetrieval } from '@kb/client/cli/chat-query-orchestrator.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import { isReadFactsResult } from '@kb/core/query/intent-cli.js'
import { describe, expect, it, vi } from 'vitest'

describe('chat-query-orchestrator', () => {
  it('[TC-FR8X] Given a mocked read_facts result, then returns accepted read_facts IntentResult', async () => {
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

  it('[TC-7Q1C] Given a baseDir, then chat retrieval uses the query pipeline and does not call read_facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-chat-orch-'))
    try {
      const executor: ToolExecutor = {
        register: vi.fn(),
        getTools: vi.fn(() => []),
        execute: vi.fn(async () => ({ results: [] })),
      }
      const result = await executeChatQueryTruthRetrieval({
        toolExecutor: executor,
        expandedQuery: 'how does auth work?',
        retrievalLimit: 5,
        baseDir: dir,
        config: {} as never,
      })
      expect(executor.execute).not.toHaveBeenCalled()
      expect(result.status).toBe('uncertain')
      expect(result.explanation).toContain('empty')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
