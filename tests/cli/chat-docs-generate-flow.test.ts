import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDocsGenerateChatFlow } from '@kb/client/cli/chat-docs-generate-flow.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { loadQuestionnaire } from '@kb/core/core/doc-questionnaire.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { createPrinter } from '@kb/client/ui/printer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('chat-docs-generate-flow', () => {
  it('[TC-75] Given slash line with prompt, answers questionnaire and accept writes document', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-chat-docgen-'))
    tempDirs.push(baseDir)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'chat wizard fact.',
      sourceKind: 'submit',
      sourceRef: 't',
      confidence: 0.9,
    })
    indexer.close()

    const mockLlm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'CHATBODY\n',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 2, outputTokens: 2 },
      })),
    }

    const qn = loadQuestionnaire('reference').length
    const answers = Array.from({ length: qn }, (_, i) => `chat-ans-${i}`)
    const readQueue = ['/skip', ...answers, '/accept']
    let readIdx = 0

    const logged: string[] = []
    const printer = createPrinter(
      {
        log: line => logged.push(line),
        write: line => logged.push(line),
        error: line => logged.push(`ERR:${line}`),
      },
      'cli'
    )

    await runDocsGenerateChatFlow({
      read: async () => readQueue[readIdx++] ?? null,
      writeError: line => logged.push(`ERR:${line}`),
      printer,
      llm: mockLlm,
      kbStorageDir: baseDir,
      config: {} as KbConfig,
      slashRest: 'chat topic',
      chatTranscript: 'User:\nKeep the diagram section.\n',
    })

    expect(logged.some(l => l.includes('Accepted.') && l.includes('Document id:'))).toBe(true)
    expect(mockLlm.call).toHaveBeenCalled()
    const draftPayload = vi.mocked(mockLlm.call).mock.calls.find(args => {
      const u = args[0]?.messages?.[0]?.content
      return typeof u === 'string' && u.includes('KB chat transcript')
    })
    expect(draftPayload?.[0]?.messages?.[0]?.content).toContain('Keep the diagram section')
  })
})
