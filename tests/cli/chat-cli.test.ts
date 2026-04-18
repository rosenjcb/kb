import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import { buildChatTurnContent, printChatHelp, runChatSession } from '../../src/cli/chat-cli'
import { createKBToolsRegistry } from '../../src/tools/kb-tools-registry'
import { DefaultIntentRouter } from '../../src/intents/router'
import { invalidateFactTool } from '../../src/tools/invalidate-fact-tool'

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
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      name: 'read_documents',
      input: expect.objectContaining({
        query: 'How retrieval works?',
        mode: 'content',
        includeContent: true,
      }),
    }))
    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> The KB uses a hybrid path with lexical fallback.')
    expect(io.outputs.join('\n')).toContain('retrieval> hybrid (fts+vector-rerank)')
    expect(io.outputs.join('\n')).toContain('checkpoints> hybrid_primary:hit->return')
    expect(io.outputs.join('\n')).toContain('sources> session-log-2026-04-12')
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

  it('Given LLM insufficiency on first call, then chat triggers deep retry and uses the retry LLM answer', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          { metadata: { id: 'general-facts' }, content: '# general facts\n\n- Rollout strategy is immediate.\n' },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The evidence provided does not contain specific information about rollout strategy.',
          stopReason: 'end_turn', toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Rollout strategy is immediate.',
          stopReason: 'end_turn', toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
    expect(io.outputs.join('\n')).toContain('chat-deep-discovery-promotion')
    expect(io.outputs.join('\n')).toContain('sources> general-facts')
  })

  it('Given broad project question with ticket-only retrieval, then workspace fallback evidence is included', async () => {
    const workspaceDir = await createTempDir()
    await writeFile(
      path.join(workspaceDir, 'README.md'),
      '# KB Agent Harness\n\nThis project provides an intent-first local KB CLI with retrieval and writing tools.\n',
      'utf8',
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
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor, workspaceDir }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(1)
    const callInput = (provider.call as { mock: { calls: Array<[any]> } }).mock.calls[0][0]
    const message = callInput.messages[0]?.content
    expect(message).toContain('workspace-readme')
    expect(message).toContain('intent-first local KB CLI')
    expect(io.outputs.join('\n')).toContain('retrieval> hybrid (fts+vector-rerank;workspace-fallback)')
    expect(io.outputs.join('\n')).toContain('sources> session-log-2026-04-12, workspace-readme')
  })

  it('Given insufficient LLM answer, then chat runs deep retry and uses the deep LLM answer', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          { metadata: { id: 'general-facts' }, content: '# general facts\n\n- CLI testing fact: lane checks only.\n' },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved documents do not provide specific details about rollout strategy.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Rollout strategy is immediate.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(executor.execute).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
    expect(io.outputs.join('\n')).toContain('chat-deep-discovery-promotion')
  })

  it('Given CLI question and insufficiency LLM answer, then deep retry is triggered and returns real answer', async () => {
    const io = new ScriptedIO(['how does the kb cli work', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
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
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved evidence does not provide specific information on how the KB CLI works.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Use kb --help for a full list of commands.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Use kb --help for a full list of commands.')
    expect(io.outputs.join('\n')).toContain('chat-deep-discovery-promotion')
  })

  it('Given "does not provide specific details" wording, then deep retry is triggered', async () => {
    const io = new ScriptedIO(['explain the cli', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: '# general facts\n\n- CLI quick-reference: kb --help; kb submit.',
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved evidence does not provide specific details on how the CLI works.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'The CLI starts with kb --help.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> The CLI starts with kb --help.')
  })

  it('Given "does not contain specific information" wording, then deep retry is triggered', async () => {
    const io = new ScriptedIO(['explain the cli', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: '# general facts\n\n- CLI quick-reference: kb --help.',
          },
        ],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved evidence does not contain specific information about the CLI.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'The CLI uses kb --help to show all commands.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> The CLI uses kb --help to show all commands.')
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
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const firstCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall?.name).toBe('read_documents')
    expect(firstCall?.input?.discoveryDepth).toBe('deep')
    expect(firstCall?.input?.limit).toBe(12)
  })

  it('Given high-recall token question without matching evidence, then deep retry is triggered and LLM answer used', async () => {
    const io = new ScriptedIO(['CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValue({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: '# general facts\n\n- CLI quick-reference: kb --help; kb query --output json.\n',
          },
        ],
      }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved documents do not contain any information about this token.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'The retrieved documents do not contain any information about this token.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    // Deep retry should be triggered (2 LLM calls) because the first answer looks insufficient
    expect(provider.call).toHaveBeenCalledTimes(2)
    // The output should use the LLM answer (not extract CLI quick-reference line)
    const output = io.outputs.join('\n')
    expect(output).toContain('assistant> The retrieved documents do not contain any information about this token.')
    expect(output).not.toContain('assistant> CLI quick-reference')
  })

  it('Given "does not contain any information about" wording, then deep retry is triggered and deep LLM answer used', async () => {
    const io = new ScriptedIO(['What is the rollout strategy?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
          results: [{ metadata: { id: 'general-facts' }, content: '# general facts\n\n- lane checks only.\n' }],
        })
        .mockResolvedValueOnce({
          retrieval: { method: 'hybrid', detail: 'deep-discovery' },
          results: [{ metadata: { id: 'general-facts' }, content: '# general facts\n\n- Rollout strategy is immediate.\n' }],
        }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved documents do not contain any information about rollout strategy.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Rollout strategy is immediate.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(2)
    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
  })

  it('Given question about .env.local and insufficient LLM answer, then deep retry is triggered and specific answer used', async () => {
    const io = new ScriptedIO(['explain the .env.local situation', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
        results: [
          {
            metadata: { id: 'general-facts' },
            content: [
              '# general facts',
              '',
              '- CLI quick-reference: kb --help; kb submit/query/validate/dispute/explain with --output json.',
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
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved evidence does not contain specific information about .env.local.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Environment loading order: .env.local is loaded before .env.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Environment loading order: .env.local is loaded before .env.')
    expect(io.outputs.join('\n')).not.toContain('assistant> CLI quick-reference:')
  })

  it('Given singular insufficiency wording about retrieved document, then chat still performs recovery and surfaces grounded fallback', async () => {
    const io = new ScriptedIO(['What is the release process?', '/exit'])

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
            {
              metadata: { id: 'using-intent-commands-in-kb' },
              content: '# using intent commands\n\n- Use submit and query for KB interactions.\n',
            },
          ],
        })
        .mockResolvedValueOnce({
          retrieval: {
            method: 'hybrid',
            detail: 'deep-discovery',
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
      call: vi.fn()
        .mockResolvedValueOnce({
          text: 'The retrieved document does not provide information about the release process.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'Release process uses GitHub Actions.',
          stopReason: 'end_turn' as const, toolUses: [], usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor, conversationalRetrieval: true }, io)

    expect(io.outputs.join('\n')).toContain('assistant> Release process uses GitHub Actions.')
    expect(io.outputs.join('\n')).toContain('chat-deep-discovery-promotion')
  })

  it('Given low-confidence advance checkpoint, then chat performs recovery retrieval attempt', async () => {
    const io = new ScriptedIO(['What should I do for unknown runtime warning?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          retrieval: {
            method: 'lexical-fallback',
            detail: 'fts-no-candidates',
            checkpoints: [
              {
                stage: 'lexical_recovery',
                status: 'miss',
                nextAction: 'advance',
                confidence: 0,
              },
            ],
          },
          results: [],
        })
        .mockResolvedValueOnce({
          retrieval: {
            method: 'lexical',
            detail: 'hybrid-not-attempted',
            checkpoints: [
              {
                stage: 'query_rewrite_retry',
                status: 'hit',
                nextAction: 'return',
                confidence: 0.55,
              },
            ],
          },
          results: [{ metadata: { id: 'known-runbook' }, content: 'Known runbook recovery content.' }],
        }),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Try the known runbook recovery steps first.',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(2)
    expect(io.outputs.join('\n')).toContain('assistant> Try the known runbook recovery steps first.')
    expect(io.outputs.join('\n')).toContain('retrieval> lexical (hybrid-not-attempted;chat-recovery-retry)')
    expect(io.outputs.join('\n')).toContain('sources> known-runbook')
  })

  it('Given conversational retrieval enabled, then a confirmation turn reuses the pending search query instead of querying the literal confirmation text', async () => {
    const io = new ScriptedIO(['What is TUI and how do we implement it?', 'Yeah let’s do the search', '/exit'])

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
          results: [{ metadata: { id: 'kb-system-overview' }, content: 'KB system overview only.' }],
        })
        .mockResolvedValueOnce({
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
      call: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'I can continue if you want me to search the KB for TUI implementation details. Please let me know if you would like me to perform this search.',
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'I can continue if you want me to search the KB for TUI implementation details. Please let me know if you would like me to perform this search.',
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession(
      { llmProvider: provider, toolExecutor: executor, conversationalRetrieval: true },
      io,
    )

    const calls = (executor.execute as { mock: { calls: Array<[any]> } }).mock.calls
    expect(calls[0]?.[0]?.input?.query).toBe('What is TUI and how do we implement it?')
    expect(calls[1]?.[0]?.input?.query).toBe('What is TUI and how do we implement it?')
  })

  it('Given conversational retrieval disabled, then a confirmation turn still queries the literal follow-up text', async () => {
    const io = new ScriptedIO(['What is TUI and how do we implement it?', 'Yeah let’s do the search', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi
        .fn()
        .mockResolvedValue({
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
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession(
      { llmProvider: provider, toolExecutor: executor, conversationalRetrieval: false },
      io,
    )

    const calls = (executor.execute as { mock: { calls: Array<[any]> } }).mock.calls
    expect(calls[1]?.[0]?.input?.query).toBe('Yeah let’s do the search')
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
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const firstIo = new ScriptedIO(['What is the release process?', '/exit'])
    await runChatSession(
      { llmProvider: firstProvider, toolExecutor, conversationalRetrieval: true, graphWriter: undefined },
      firstIo,
    )
    expect(firstIo.outputs.join('\n')).toContain('GitHub Actions')

    await invalidateFactTool({
      oldFact: 'Release process uses GitHub Actions.',
      replacementFact: 'Release process uses Buildkite.',
      preview: false,
    }, baseDir)

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
      { llmProvider: secondProvider, toolExecutor, conversationalRetrieval: true, graphWriter: undefined },
      secondIo,
    )

    const secondOutput = secondIo.outputs.join('\n')
    expect(secondOutput).toContain('Buildkite')
    expect(secondOutput).not.toContain('GitHub Actions. (source:')
  })
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
