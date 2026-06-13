import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatTurnContent, printChatHelp, runChatSession, runChatSynthesis } from '../../src/cli/chat-cli'
import * as initCli from '../../src/cli/init-cli'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import { invalidateFactTool } from '../../src/tools/invalidate-fact-tool'
import { createKBToolsRegistry } from '../../src/tools/kb-tools-registry'

class ScriptedIO {
  public readonly outputs: string[] = []
  public readonly errors: string[] = []
  public readonly progressLines: Array<string | null> = []

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

  setProgressLine(line: string | null): void {
    this.progressLines.push(line)
  }
}

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-chat-'))
  tempDirs.push(dir)
  return dir
}

describe('chat-cli prompt', () => {
  it('Given chat help printer, then returns grouped usage and interactive commands including /clear', () => {
    const help = printChatHelp()
    expect(help).toContain('kb chat')
    expect(help).toContain('Usage:')
    expect(help).toContain('/help')
    expect(help).toContain('/clear')
    expect(help).toContain('/exit')
    expect(help).toContain('--verbose')
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

  it('Given long retrieved fact bodies, then turn content truncates each fact for synthesis', () => {
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

  it('Given a session pool with prior facts not in current retrieval, then turn content includes session pool section', () => {
    const content = buildChatTurnContent({
      question: 'What about AST support?',
      retrieval: {
        results: [
          { metadata: { id: 'fact-new' }, content: 'AST promotes symbols to facts table.' },
        ],
      },
      sessionPool: [
        { id: 'fact-prior', text: 'Agent loop orchestrates retrieval across hops.' },
      ],
    })

    expect(content).toContain('Session fact pool')
    expect(content).toContain('fact-prior')
    expect(content).toContain('Agent loop orchestrates retrieval across hops.')
  })

  it('Given a session pool where all facts are already in current retrieval, then no session pool section appears', () => {
    const content = buildChatTurnContent({
      question: 'What about AST support?',
      retrieval: {
        results: [
          { metadata: { id: 'fact-a' }, content: 'AST promotes symbols to facts table.' },
        ],
      },
      sessionPool: [
        { id: 'fact-a', text: 'AST promotes symbols to facts table.' },
      ],
    })

    expect(content).not.toContain('Session fact pool')
  })
})

/** Build a provider mock that first routes via query_kb, then synthesizes from tool results. */
function makeKBProvider(answer: string, query: string): LLMProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    supportsStreaming: false,
    call: vi
      .fn()
      .mockResolvedValueOnce({
        text: '',
        stopReason: 'tool_use' as const,
        toolUses: [{ id: 'tu-1', name: 'query_kb', input: { q: query } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValue({
        text: answer,
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  }
}

/** Build an executor that returns a single result with the given content. */
function makeExecutor(content: string, id = 'fact-1', method = 'hybrid', detail = 'research-orchestrator'): ToolExecutor {
  return {
    register: vi.fn(),
    getTools: vi.fn(() => []),
    execute: vi.fn(async () => ({
      retrieval: { method, detail },
      results: [{ metadata: { id }, content }],
    })),
  }
}

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

    expect(io.outputs.join('\n')).toContain('Type a question')
    expect(io.outputs.join('\n')).toContain('/help')
    expect(io.outputs.join('\n')).not.toContain('Exiting chat')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('Given /clear, then prints fresh session message and subsequent turn uses empty message history', async () => {
    const io = new ScriptedIO(['/clear', '/exit'])
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

    expect(io.outputs.join('\n')).toContain('Fresh session')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('Given /init in chat mode, then progress updates use the dedicated progress hook instead of transcript history', async () => {
    const io = new ScriptedIO(['/init', 'crawler-3', '/exit'])
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

    const initSpy = vi.spyOn(initCli, 'runKbInit').mockImplementation(async options => {
      options.questionIO?.write?.('\n[kb init] Choose a knowledge base name for this run.\n\n')
      const answer = await options.questionIO?.askQuestion?.('> Knowledge base name [crawlee] ')
      expect(answer).toBe('crawler-3')
      options.progressSink?.('[init] [------------------------] 0/7 read-inputs discovering docs…')
      options.progressSink?.('[init] [===---------------------] 1/7 document-facts 📄 indexing document sentences into facts…')
      return {
        status: 'accepted',
        base: 'crawler-3',
        completedCycles: ['read-inputs'],
        writtenDocIds: ['doc-1'],
      }
    })

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(io.outputs.join('\n')).toContain('Starting init…')
    expect(io.outputs.join('\n')).toContain('Choose a knowledge base name')
    expect(io.outputs.join('\n')).toContain('✅ Init complete — 1 doc written to "crawler-3"')
    expect(io.outputs.some(line => line.startsWith('[init]'))).toBe(false)
    expect(io.progressLines).toContain(
      '[init] [===---------------------] 1/7 document-facts 📄 indexing document sentences into facts…'
    )
    expect(io.progressLines.filter(line => line === null).length).toBeGreaterThanOrEqual(2)

    initSpy.mockRestore()
  })

  it('Given a simple greeting, then LLM answers directly without calling executor', async () => {
    const io = new ScriptedIO(['hi', '/exit'])

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
        text: 'Hello! Ask me anything about the codebase.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(provider.call).toHaveBeenCalledTimes(1)
    expect(executor.execute).not.toHaveBeenCalled()
    expect(io.outputs.join('\n')).toContain('assistant> Hello! Ask me anything about the codebase.')
  })

  it('Given a KB question, then LLM calls query_kb, retrieval runs, and LLM synthesizes the answer', async () => {
    const io = new ScriptedIO(['How retrieval works?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: {
          method: 'hybrid',
          detail: 'fts+vector-rerank',
          checkpoints: [{ stage: 'hybrid_primary', status: 'hit', nextAction: 'return', confidence: 0.86 }],
        },
        results: [{ metadata: { id: 'session-log-2026-04-12' }, content: 'Hybrid retrieval details.' }],
      })),
    }

    const provider = makeKBProvider('The KB uses a hybrid path with lexical fallback.', 'How retrieval works?')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 4096,
        systemPrompt: expect.stringContaining('knowledge base assistant'),
      })
    )
    expect(io.outputs.join('\n')).toContain('assistant> The KB uses a hybrid path with lexical fallback.')
    expect(io.outputs.join('\n')).toContain('retrieval> hybrid (fts+vector-rerank)')
    expect(io.outputs.join('\n')).toContain('session-log-2026-04-12')
  })

  it('Given provider failure, then loop reports error and remains interactive', async () => {
    const io = new ScriptedIO(['What now?', '/exit'])

    const executor: ToolExecutor = { register: vi.fn(), getTools: vi.fn(() => []), execute: vi.fn() }
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => { throw new Error('provider offline') }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(io.errors.join('\n')).toContain('Chat turn failed: provider offline')
  })

  it('Given a KB question, then retrieval always uses deep discovery policy', async () => {
    const io = new ScriptedIO(['explain the cli', '/exit'])

    const executor = makeExecutor('- CLI: kb --help.')
    const provider = makeKBProvider('The CLI starts with kb --help.', 'explain the cli')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const firstCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall?.input?.discoveryDepth).toBe('deep')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> The CLI starts with kb --help.')
  })

  it('Given a KB question, then retrieval call has correct read_facts shape', async () => {
    const io = new ScriptedIO(['what is the rollout strategy?', '/exit'])

    const executor = makeExecutor('- Rollout strategy is immediate.', 'rollout-facts')
    const provider = makeKBProvider('Rollout strategy is immediate.', 'what is the rollout strategy?')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_facts',
        input: expect.objectContaining({ mode: 'content', includeContent: true }),
      })
    )
    expect(io.outputs.join('\n')).toContain('assistant> Rollout strategy is immediate.')
    expect(io.outputs.join('\n')).toContain('rollout-facts')
  })

  it('Given a two-turn session, then second LLM call includes first-turn context in message history', async () => {
    const io = new ScriptedIO(['What is the agent loop?', 'What about AST?', '/exit'])

    const executor = makeExecutor('Agent loop content.', 'fact-agent-loop')
    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({  // turn 1: route → query_kb
          text: '', stopReason: 'tool_use' as const,
          toolUses: [{ id: 'tu-1', name: 'query_kb', input: { q: 'What is the agent loop?' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({  // turn 1: synthesize
          text: 'Agent loop answer.',
          stopReason: 'end_turn' as const, toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({  // turn 2: route → query_kb
          text: '', stopReason: 'tool_use' as const,
          toolUses: [{ id: 'tu-2', name: 'query_kb', input: { q: 'What about AST?' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValue({  // turn 2: synthesize
          text: 'AST answer.',
          stopReason: 'end_turn' as const, toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const turn2RoutingCall = (provider.call as ReturnType<typeof vi.fn>).mock.calls[2]
    const messagesInTurn2 = turn2RoutingCall?.[0]?.messages as Array<{ role: string; content: unknown }>
    // Prior user message and assistant answer should be in history
    const roles = messagesInTurn2?.map(m => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    const assistantMsg = messagesInTurn2?.find(m => m.role === 'assistant')
    expect(String(assistantMsg?.content)).toContain('Agent loop answer.')
  })

  it('Given a process question, then query_kb tool is called and answer is surfaced', async () => {
    const io = new ScriptedIO(['What is the release process?', '/exit'])

    const executor = makeExecutor('# ops facts\n\n- Release process uses GitHub Actions.\n', 'ops-facts')
    const provider = makeKBProvider('Release process uses GitHub Actions.', 'What is the release process?')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Release process uses GitHub Actions.')
  })

  it('Given an unknown runtime question, then query_kb retrieves runbook and surfaces the answer', async () => {
    const io = new ScriptedIO(['What should I do for unknown runtime warning?', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn().mockResolvedValueOnce({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator',
          checkpoints: [{ stage: 'research_loop', status: 'hit', nextAction: 'return', confidence: 0.75 }] },
        results: [{ metadata: { id: 'known-runbook' }, content: 'Known runbook recovery content.' }],
      }),
    }

    const provider = makeKBProvider('Try the known runbook recovery steps first.', 'What should I do for unknown runtime warning?')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(io.outputs.join('\n')).toContain('assistant> Try the known runbook recovery steps first.')
    expect(io.outputs.join('\n')).toContain('known-runbook')
  })

  it('Given user message that is just a follow-up phrase, then LLM can answer directly without retrieval', async () => {
    const io = new ScriptedIO(["Yeah let's do the search", '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'I can continue if you want me to search the KB for TUI implementation details.',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(executor.execute).not.toHaveBeenCalled()
    expect(io.outputs.join('\n')).toContain('I can continue if you want me to search the KB')
  })

  it('Given fact upsert and invalidate changes in the same base, then conversational chat reflects updated facts across turns', async () => {
    const baseDir = await createTempDir()
    const config = { graph: { enabled: false } }
    const toolExecutor = createKBToolsRegistry(baseDir, config)

    await toolExecutor.execute({
      name: 'upsert_fact',
      input: {
        factText: 'Release process uses GitHub Actions.',
        sourceKind: 'import_doc',
        sourceRef: 'test',
        confidence: 0.9,
      },
    })

    const firstProvider = makeKBProvider('Release process uses GitHub Actions.', 'What is the release process?')
    const firstIo = new ScriptedIO(['What is the release process?', '/exit'])
    await runChatSession({ llmProvider: firstProvider, toolExecutor, graphWriter: undefined }, firstIo)
    expect(firstIo.outputs.join('\n')).toContain('GitHub Actions')

    await invalidateFactTool(
      {
        oldFact: 'Release process uses GitHub Actions.',
        replacementFact: 'Release process uses Buildkite.',
        preview: false,
      },
      baseDir
    )

    const secondProvider = makeKBProvider('Release process uses Buildkite.', 'What is the release process?')
    const secondIo = new ScriptedIO(['What is the release process?', '/exit'])
    await runChatSession({ llmProvider: secondProvider, toolExecutor, graphWriter: undefined }, secondIo)

    const secondOutput = secondIo.outputs.join('\n')
    expect(secondOutput).toContain('Buildkite')
    expect(secondOutput).not.toContain('GitHub Actions. (source:')
  })

  it('Given a multi-round query where LLM calls query_kb twice across rounds, then both retrievals run and final answer is returned', async () => {
    const io = new ScriptedIO(['How does the agent loop work?', '/exit'])
    const executor = makeExecutor('Agent loop content.', 'agent-loop-doc')

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: '',
          stopReason: 'tool_use' as const,
          toolUses: [{ id: 'tu-1', name: 'query_kb', input: { q: 'agent loop' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: '',
          stopReason: 'tool_use' as const,
          toolUses: [{ id: 'tu-2', name: 'query_kb', input: { q: 'agent loop exit condition' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValue({
          text: 'The agent loop runs until no tool calls are produced.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    // Two retrieval rounds → executor called twice, provider called three times
    expect(executor.execute).toHaveBeenCalledTimes(2)
    expect(provider.call).toHaveBeenCalledTimes(3)
    expect(io.outputs.join('\n')).toContain('The agent loop runs until no tool calls are produced.')
  })

  it('Given a turn where LLM returns two tool calls in one round, then both execute and results are returned', async () => {
    const io = new ScriptedIO(['Compare retrieval strategies', '/exit'])

    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({
        retrieval: { method: 'hybrid', detail: 'research-orchestrator' },
        results: [{ metadata: { id: 'fact-1' }, content: 'Retrieval strategy content.' }],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        .mockResolvedValueOnce({
          text: '',
          stopReason: 'tool_use' as const,
          toolUses: [
            { id: 'tu-1', name: 'query_kb', input: { q: 'hybrid retrieval' } },
            { id: 'tu-2', name: 'query_kb', input: { q: 'vector retrieval' } },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValue({
          text: 'Hybrid and vector retrieval both available.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    // Both tool calls in the same round → executor called twice
    expect(executor.execute).toHaveBeenCalledTimes(2)
    // Both query> lines should appear in output (logged before parallel execution)
    const out = io.outputs.join('\n')
    expect(out).toContain('query> hybrid retrieval')
    expect(out).toContain('query> vector retrieval')
    expect(out).toContain('Hybrid and vector retrieval both available.')
  })

  it('Given a synthesis keyword query, then decompose pre-step fires and sub-queries are logged before main loop', async () => {
    // Query must be ≥40 chars to pass the decompose length guard
    const io = new ScriptedIO(['Give me an overview of how the kb init process works', '/exit'])

    const executor = makeExecutor('Init process content.', 'init-doc')

    const provider: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      call: vi.fn()
        // First call: decompose → returns two sub-query lines
        .mockResolvedValueOnce({
          text: 'kb init command behavior\nread-inputs cycle during init',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        // Remaining calls: main loop synthesis
        .mockResolvedValue({
          text: 'The init process reads inputs then writes documents.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    const out = io.outputs.join('\n')
    // Both sub-queries logged (from the decompose pre-step)
    expect(out).toContain('query> kb init command behavior')
    expect(out).toContain('query> read-inputs cycle during init')
    // Provider called at least twice: once for decompose, once for main loop
    expect((provider.call as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(out).toContain('The init process reads inputs then writes documents.')
  })

  it('Given a short or non-synthesis query, then decompose pre-step is skipped', async () => {
    const io = new ScriptedIO(['What is kb?', '/exit'])
    const executor = makeExecutor('kb is a knowledge base tool.', 'kb-doc')
    const provider = makeKBProvider('kb is a knowledge base tool.', 'What is kb?')

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    // No decompose call — provider called exactly twice (route → synthesize), executor once
    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(executor.execute).toHaveBeenCalledTimes(1)
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
      } as Parameters<typeof runChatSynthesis>[0]['printer'],
      lines,
    }
  }

  it('Given retrieval provided, then synthesizes answer from pre-fetched context without extra retrieval', async () => {
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

  it('Given multi-round loop, then calls query_kb in parallel and populates lastIntentResult', async () => {
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
      call: vi.fn()
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
    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(result.answer).toBe('Full answer after parallel retrieval.')
    // lastIntentResult populated from tool retrieval
    expect(result.lastIntentResult).toBeDefined()
    // facts from initial retrieval + two parallel retrievals
    expect(result.factsRetrieved).toBeGreaterThanOrEqual(3)
  })

  it('Given retrieval undefined (chat path), then starts loop from provided messages directly', async () => {
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
