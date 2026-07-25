import { describe, expect, it, vi } from 'vitest'

vi.mock('@kb/client/cli/remote-commands.js', () => ({
  runRemoteChatSession: vi.fn().mockResolvedValue(undefined),
}))

import {
  buildChatTurnContent,
  printChatHelp,
  runChatSession,
  runChatSynthesis,
} from '@kb/client/cli/chat-cli.js'
import { runRemoteChatSession } from '@kb/client/cli/remote-commands.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider } from '@kb/core/core/types.js'

const mockRunRemoteChatSession = vi.mocked(runRemoteChatSession)

describe('chat-cli prompt', () => {
  it('[TC-77] Given chat help printer, then returns grouped usage and interactive commands including /clear', () => {
    const help = printChatHelp()
    expect(help).toContain('kb chat')
    expect(help).toContain('Usage:')
    expect(help).toContain('/help')
    expect(help).toContain('/clear')
    expect(help).toContain('/exit')
    expect(help).toContain('--verbose')
  })

  it('[TC-78] Given evidence and question, then turn content includes evidence block and question without embedded history', () => {
    const content = buildChatTurnContent({
      question: 'How does base precedence work?',
      retrieval: {
        results: [
          {
            metadata: { id: 'general-facts' },
            content: 'KB base precedence: session base, default base.',
          },
        ],
      },
    })

    expect(content).toContain('Retrieved evidence:')
    // Evidence body is present, but not framed as a citable "Fact N (id=...)" item.
    expect(content).toContain('KB base precedence: session base, default base.')
    expect(content).not.toMatch(/Fact \d/)
    expect(content).not.toContain('id=')
    expect(content).toContain('User question: How does base precedence work?')
    expect(content).not.toContain('Conversation history:')
  })

  it('[TC-79] Given long retrieved fact bodies, then turn content truncates each fact for synthesis', () => {
    const long = 'z'.repeat(2500)
    const content = buildChatTurnContent({
      question: 'What is kb?',
      retrieval: {
        results: [{ metadata: { id: 'fact-long' }, content: long }],
      },
    })

    expect(content).toContain('z'.repeat(2000))
    expect(content).toContain('…')
    expect(content).not.toContain(long)
  })
})

describe('chat-cli session loop', () => {
  it('[TC-80] Given runChatSession, then delegates to runRemoteChatSession', async () => {
    mockRunRemoteChatSession.mockClear()
    mockRunRemoteChatSession.mockResolvedValue(undefined)

    const deps = { verbose: true }
    const io = {
      read: async (_prompt: string) => null,
      write: () => {},
      error: () => {},
      setProgressLine: () => {},
    }

    await runChatSession(deps, io)

    expect(mockRunRemoteChatSession).toHaveBeenCalledTimes(1)
    expect(mockRunRemoteChatSession).toHaveBeenCalledWith(deps, io)
  })
})

describe('runChatSynthesis', () => {
  function makePrinter() {
    const lines: string[] = []
    return {
      printer: {
        chatMeta: (_k: string, _v: string) => {},
        chatAssistant: (s: string) => lines.push(s),
        separator: () => {},
        log: (s: string) => lines.push(s),
        write: (s: string) => lines.push(s),
        error: (s: string) => lines.push(s),
        progress: (_s: string) => {},
        clearProgress: () => {},
      } as Parameters<typeof runChatSynthesis>[0]['printer'],
      lines,
    }
  }

  it('[TC-96] Given retrieval provided, then synthesizes answer from pre-fetched context without extra retrieval', async () => {
    const { printer } = makePrinter()
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(),
    }
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'The answer is 42.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    }

    const result = await runChatSynthesis({
      question: 'What is the answer?',
      retrieval: { results: [{ metadata: { id: 'fact-1' }, content: 'The answer is 42.' }] },
      messages: [],
      llmProvider: provider,
      toolExecutor: executor,
      printer,
    })

    expect(result.answer).toBe('The answer is 42.')
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(5)
    expect(result.factsRetrieved).toBe(1)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('[TC-97] Given multi-round loop, then calls query_kb in parallel and populates lastIntentResult', async () => {
    const { printer } = makePrinter()
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValue({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator' },
        results: [{ metadata: { id: 'fact-r2' }, content: 'Extra context.' }],
      }),
    }
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi
        .fn()
        .mockResolvedValueOnce({
          text: '',
          stopReason: 'tool_use' as const,
          toolUses: [
            { id: 'tu-1', name: 'query_kb', input: { q: 'angle one' } },
            { id: 'tu-2', name: 'query_kb', input: { q: 'angle two' } },
          ],
          usage: { inputTokens: 5, outputTokens: 2 },
        })
        .mockResolvedValue({
          text: 'Full answer after parallel retrieval.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 5, outputTokens: 10 },
        }),
    }

    const result = await runChatSynthesis({
      question: 'Tell me everything.',
      retrieval: { results: [{ metadata: { id: 'fact-0' }, content: 'Initial context.' }] },
      messages: [],
      llmProvider: provider,
      toolExecutor: executor,
      printer,
    })

    // Both parallel tool calls triggered executor twice
    expect(executor.execute).toHaveBeenCalledTimes(2)
    // one round with two parallel tool calls, route→done, then synthesis
    expect(provider.call).toHaveBeenCalledTimes(3)
    expect(result.answer).toBe('Full answer after parallel retrieval.')
    // lastIntentResult populated from tool retrieval
    expect(result.lastIntentResult).toBeDefined()
    // facts from initial retrieval + two parallel retrievals
    expect(result.factsRetrieved).toBeGreaterThanOrEqual(3)
  })

  it('[TC-98] Given retrieval undefined (chat path), then starts loop from provided messages directly', async () => {
    const { printer } = makePrinter()
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(),
    }
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'Direct answer from history.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 3, outputTokens: 7 },
      }),
    }

    const result = await runChatSynthesis({
      question: 'Anything?',
      retrieval: undefined,
      messages: [{ role: 'user', content: 'Anything?' }],
      llmProvider: provider,
      toolExecutor: executor,
      printer,
    })

    expect(result.answer).toBe('Direct answer from history.')
    expect(result.factsRetrieved).toBe(0)
    expect(result.lastIntentResult).toBeUndefined()
    expect(executor.execute).not.toHaveBeenCalled()
  })
})
