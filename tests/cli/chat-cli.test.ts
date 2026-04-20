import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatTurnContent, printChatHelp, runChatSession } from '../../src/cli/chat-cli'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import { DefaultIntentRouter } from '../../src/intents/router'
import { invalidateFactTool } from '../../src/tools/invalidate-fact-tool'
import { createKBToolsRegistry } from '../../src/tools/kb-tools-registry'

class ScriptedIO {
  public readonly outputs: string[] = []
  public readonly errors: string[] = []

  constructor(private readonly inputs: Array<string | null>) {}

  async read(): Promise<string | null> {
    return this.inputs.shift() ?? null
  }

  write(line: string): void {
    this.outputs.push(line)
  }

  error(line: string): void {
    this.errors.push(line)
  }
}

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-chat-'))
  tempDirs.push(dir)
  return dir
}

describe('chat-cli prompt', () => {
  it('Given chat help printer, then returns grouped usage and interactive commands', () => {
    const help = printChatHelp()
    expect(help).toContain('kb chat')
    expect(help).toContain('Usage:')
    expect(help).toContain('/help')
    expect(help).toContain('/exit')
  })

  it('Given evidence and question, then turn content includes evidence block and question without embedded history', () => {
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
    expect(content).toContain('general-facts')
    expect(content).toContain('User question: How does base precedence work?')
    expect(content).not.toContain('Conversation history:')
  })
})

describe('chat-cli session loop', () => {
  it('Given /help and /exit, then prints commands and exits without tool calls', async () => {
    const io = new ScriptedIO(['/help', '/exit'])
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(),
    }
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(io.outputs.join('\n')).toContain('Chat mode started')
    expect(io.outputs.join('\n')).toContain('/help')
    expect(io.outputs.join('\n')).toContain('Exiting chat')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('Given a user question, then retrieves evidence, calls LLM, and prints retrieval metadata', async () => {
    const io = new ScriptedIO(['How retrieval works?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: {
          method: 'hybrid',
          detail: 'fts+vector-rerank',
          checkpoints: [
            {
              stage: 'hybrid_primary',
              status: 'hit',
              nextAction: 'return',
              confidence: 0.86,
            },
          ],
        },
        results: [
          { metadata: { id: 'session-log-2026-04-12' }, content: 'Hybrid retrieval details.' },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'The KB uses a hybrid path with lexical fallback.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_documents',
        input: expect.objectContaining({
          query: 'How retrieval works?',
          mode: 'content',
          includeContent: true,
        }),
      })
    )
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 4096,
        systemPrompt: expect.stringContaining('several rich paragraphs'),
      })
    )
    expect(io.outputs.join('\n')).toContain(
      'assistant> The KB uses a hybrid path with lexical fallback.'
    )
    expect(io.outputs.join('\n')).toContain('Retrieval: hybrid (fts+vector-rerank)')
    expect(io.outputs.join('\n')).toContain('(Thinking: hybrid_primary:hit->return)')
    expect(io.outputs.join('\n')).toContain('Sources: session-log-2026-04-12')
  })

  it('Given provider failure, then loop reports error and remains interactive', async () => {
    const io = new ScriptedIO(['What now?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({ results: [], retrieval: { method: 'lexical' } })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => {
        throw new Error('provider offline')
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(io.errors.join('\n')).toContain('Chat turn failed: provider offline')
    expect(io.outputs.join('\n')).toContain('Exiting chat')
  })

  it('Given deep discovery, then chat uses one retrieval call and returns the LLM answer directly', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator;iterations:1;coverage:0.72' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: '# general facts\n\n- Rollout strategy is immediate.\n',
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Rollout strategy is immediate.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
    expect(io.outputs.join('\n')).toContain('Sources: general-facts')
  })

  it('Given broad project question with ticket-only retrieval, then workspace fallback evidence is included', async () => {
    const workspaceDir = await createTempDir()
    await writeFile(
      path.join(workspaceDir, 'README.md'),
      '# KB Agent Harness\n\nThis project provides an intent-first local KB CLI with retrieval and writing tools.\n',
      'utf8'
    )

    const io = new ScriptedIO(['what is this project about?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
            checkpoints: [
              {
                stage: 'hybrid_primary',
                status: 'hit',
                nextAction: 'return',
                confidence: 0.55,
              },
            ],
          },
          results: [{ metadata: { id: 'session-log-2026-04-12' }, content: 'Session notes only.' }],
        })
        .mockResolvedValueOnce({
          retrieval: {
            method: 'lexical-fallback',
            detail: 'keyword-broadened',
            checkpoints: [
              {
                stage: 'lexical_recovery',
                status: 'hit',
                nextAction: 'return',
                confidence: 0.55,
              },
            ],
          },
          results: [{ metadata: { id: 'session-log-2026-04-12' }, content: 'Session notes only.' }],
        }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'This project is an intent-first local KB CLI with retrieval and writing tools.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor, workspaceDir }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    const callInput = (provider.call as { mock: { calls: Array<[unknown]> } }).mock.calls[0][0]
    const message = callInput.messages[0]?.content
    expect(message).toContain('workspace-readme')
    expect(message).toContain('intent-first local KB CLI')
    expect(io.outputs.join('\n')).toContain(
      'Retrieval: hybrid (fts+vector-rerank;workspace-fallback)'
    )
    expect(io.outputs.join('\n')).toContain('Sources: session-log-2026-04-12, workspace-readme')
  })

  it('Given deep retrieval, then chat uses one execute call and surfaces the LLM answer', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator;iterations:2;coverage:0.65' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: '# general facts\n\n- Rollout strategy is immediate.\n',
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Rollout strategy is immediate.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
  })

  it('Given CLI question, then chat returns the LLM answer in one round trip', async () => {
    const io = new ScriptedIO(['how does the kb cli work', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator;iterations:1;coverage:0.70' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: [
              '# general facts',
              '',
              '- CLI quick-reference: kb --help; kb use dogfood; kb submit/query/validate/dispute/explain.',
            ].join('\n'),
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Use kb --help for a full list of commands.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Use kb --help for a full list of commands.')
  })

  it('Given all chat queries, then discoveryDepth is always deep', async () => {
    const io = new ScriptedIO(['explain the cli', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator;iterations:1;coverage:0.62' },
        results: [{ metadata: { id: 'general-facts' }, content: '# general facts\n\n- CLI: kb --help.' }],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'The CLI starts with kb --help.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const firstCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall?.input?.discoveryDepth).toBe('deep')
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> The CLI starts with kb --help.')
  })

  it('Given high-recall token question, then initial retrieval uses deep discovery policy', async () => {
    const io = new ScriptedIO(['CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: {
          method: 'hybrid',
          detail: 'fts+vector-rerank',
        },
        results: [
          {
            metadata: { id: 'retrieval-facts' },
            content: '# retrieval facts\n\n- CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION\n',
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Token exists in retrieval facts.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const firstCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall?.name).toBe('read_documents')
    expect(firstCall?.input?.discoveryDepth).toBe('deep')
    expect(provider.call).toHaveBeenCalledTimes(1)
  })

  it('Given question with no matching evidence, then single LLM call is made and LLM answer is used', async () => {
    const io = new ScriptedIO(['CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValue({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content:
              '# general facts\n\n- CLI quick-reference: kb --help; kb query --output json.\n',
          },
        ],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'The retrieved documents do not contain any information about this token.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    const output = io.outputs.join('\n')
    expect(output).toContain(
      'assistant> The retrieved documents do not contain any information about this token.'
    )
    expect(output).not.toContain('assistant> CLI quick-reference')
  })

  it('Given a question with evidence, then single retrieval and single LLM call returns the answer', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValueOnce({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator' },
        results: [
          {
            metadata: { id: 'rollout-facts' },
            content: '# rollout facts\n\n- Rollout strategy is immediate.\n',
          },
        ],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'Rollout strategy is immediate.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
  })

  it('Given question about .env.local, then single LLM call surfaces the evidence answer', async () => {
    const io = new ScriptedIO(['explain the .env.local situation', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator' },
        results: [
          {
            metadata: { id: 'env-facts' },
            content: [
              '# env facts',
              '',
              '- Environment loading order: .env.local is loaded before .env.',
            ].join('\n'),
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'Environment loading order: .env.local is loaded before .env.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain(
      'assistant> Environment loading order: .env.local is loaded before .env.'
    )
  })

  it('Given conversational retrieval and a process question, then single retrieval call returns the answer', async () => {
    const io = new ScriptedIO(['What is the release process?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValueOnce({
        retrieval: {
          method: 'hybrid',
          detail: 'research-orchestrator',
        },
        results: [
          {
            metadata: { id: 'ops-facts' },
            content: '# ops facts\n\n- Release process uses GitHub Actions.\n',
          },
        ],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn().mockResolvedValueOnce({
        text: 'Release process uses GitHub Actions.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }

    await runChatSession(
      { llmProvider: provider, toolExecutor: executor, conversationalRetrieval: true },
      io
    )

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Release process uses GitHub Actions.')
  })

  it('Given an unknown runtime question, then single retrieval call uses deep orchestrator and answer is returned', async () => {
    const io = new ScriptedIO(['What should I do for unknown runtime warning?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValueOnce({
        retrieval: {
          method: 'hybrid',
          detail: 'research-orchestrator',
          checkpoints: [
            {
              stage: 'research_loop',
              status: 'hit',
              nextAction: 'return',
              confidence: 0.75,
            },
          ],
        },
        results: [
          { metadata: { id: 'known-runbook' }, content: 'Known runbook recovery content.' },
        ],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Try the known runbook recovery steps first.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain(
      'assistant> Try the known runbook recovery steps first.'
    )
    expect(io.outputs.join('\n')).toContain('Sources: known-runbook')
  })

  it('Given conversational retrieval enabled, then a confirmation turn reuses the pending search query instead of querying the literal confirmation text', async () => {
    const io = new ScriptedIO([
      'What is TUI and how do we implement it?',
      'Yeah let’s do the search',
      '/exit',
    ])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
          },
          results: [
            { metadata: { id: 'kb-system-overview' }, content: 'KB system overview only.' },
          ],
        })
        .mockResolvedValueOnce({
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
          },
          results: [
            { metadata: { id: 'kb-system-overview' }, content: 'KB system overview only.' },
          ],
        }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'I can continue if you want me to search the KB for TUI implementation details. Please let me know if you would like me to perform this search.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'I can continue if you want me to search the KB for TUI implementation details. Please let me know if you would like me to perform this search.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession(
      { llmProvider: provider, toolExecutor: executor, conversationalRetrieval: true },
      io
    )

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]?.[0]?.input?.query).toBe('What is TUI and how do we implement it?')
    expect(calls[1]?.[0]?.input?.query).toBe('What is TUI and how do we implement it?')
  })

  it('Given conversational retrieval disabled, then a confirmation turn still queries the literal follow-up text', async () => {
    const io = new ScriptedIO([
      'What is TUI and how do we implement it?',
      'Yeah let’s do the search',
      '/exit',
    ])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValue({
        retrieval: {
          method: 'hybrid',
          detail: 'fts+vector-rerank',
        },
        results: [{ metadata: { id: 'kb-system-overview' }, content: 'KB system overview only.' }],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'I can continue if you want me to search the KB for TUI implementation details. Please let me know if you would like me to perform this search.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession(
      { llmProvider: provider, toolExecutor: executor, conversationalRetrieval: false },
      io
    )

    const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[1]?.[0]?.input?.query).toBe("Yeah let’s do the search")
  })

  it('Given submit and invalidate changes in the same base, then conversational chat reflects updated facts across turns', async () => {
    const baseDir = await createTempDir()
    const config = { graph: { enabled: false } }
    const toolExecutor = createKBToolsRegistry(baseDir, config)
    const router = new DefaultIntentRouter(toolExecutor)

    await router.execute({
      intent: 'submit_fact',
      payload: {
        fact: 'Release process uses GitHub Actions.',
        domain: 'ops',
        source: 'test',
      },
    })

    const firstProvider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Release process uses GitHub Actions.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const firstIo = new ScriptedIO(['What is the release process?', '/exit'])
    await runChatSession(
      {
        llmProvider: firstProvider,
        toolExecutor,
        conversationalRetrieval: true,
        graphWriter: undefined,
      },
      firstIo
    )
    expect(firstIo.outputs.join('\n')).toContain('GitHub Actions')

    await invalidateFactTool(
      {
        oldFact: 'Release process uses GitHub Actions.',
        replacementFact: 'Release process uses Buildkite.',
        preview: false,
      },
      baseDir
    )

    const secondProvider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Release process uses Buildkite.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const secondIo = new ScriptedIO(['What is the release process?', 'Explain it more.', '/exit'])
    await runChatSession(
      {
        llmProvider: secondProvider,
        toolExecutor,
        conversationalRetrieval: true,
        graphWriter: undefined,
      },
      secondIo
    )

    const secondOutput = secondIo.outputs.join('\n')
    expect(secondOutput).toContain('Buildkite')
    expect(secondOutput).not.toContain('GitHub Actions. (source:')
  })
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
