import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import { buildChatPrompt, runChatSession } from '../../src/cli/chat-cli'

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
  it('Given history and evidence, then prompt includes both context blocks', () => {
    const prompt = buildChatPrompt({
      question: 'How does base precedence work?',
      history: [{ user: 'What controls base?', assistant: 'Session, then default.' }],
      retrieval: {
        results: [
          {
            metadata: { id: 'general-facts' },
            content: 'KB base precedence: session base, default base, KB_BASE fallback.',
          },
        ],
      },
    })

    expect(prompt).toContain('Conversation history:')
    expect(prompt).toContain('Retrieved evidence:')
    expect(prompt).toContain('general-facts')
    expect(prompt).toContain('Current user question: How does base precedence work?')
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
      supportsStreaming: false,
      call: vi.fn(async () => {
        throw new Error('provider offline')
      }),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor }, io)

    expect(io.errors.join('\n')).toContain('Chat turn failed: provider offline')
    expect(io.outputs.join('\n')).toContain('Exiting chat')
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
      execute: vi.fn(async () => ({
        retrieval: { method: 'lexical-fallback', detail: 'fts-no-candidates' },
        results: [{ metadata: { id: 'ticket-047-phase2-implementation-checkpoint' }, content: 'Ticket status notes.' }],
      })),
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'This project is an intent-first local KB CLI with retrieval and writing tools.',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    await runChatSession({ llmProvider: provider, toolExecutor: executor, workspaceDir }, io)

    expect(provider.call).toHaveBeenCalledTimes(1)
    const callInput = (provider.call as { mock: { calls: Array<[any]> } }).mock.calls[0][0]
    const message = callInput.messages[0]?.content
    expect(message).toContain('workspace-readme')
    expect(message).toContain('intent-first local KB CLI')
    expect(io.outputs.join('\n')).toContain('retrieval> lexical-fallback (fts-no-candidates;workspace-fallback)')
    expect(io.outputs.join('\n')).toContain('sources> ticket-047-phase2-implementation-checkpoint, workspace-readme')
  })
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
