import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import {
  acceptDraft,
  answerCurrent,
  produceInitialDraft,
  produceRevisedDraft,
  startGenerationSession,
} from '@kb/core/core/doc-generate-orchestrator.js'
import { loadQuestionnaire } from '@kb/core/core/doc-questionnaire.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('doc-generate-orchestrator', () => {
  it('[TC-17] Given ready session, produceInitialDraft then reject then accept writes once', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-orch-'))
    tempDirs.push(baseDir)
    const config = {} as KbConfig

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'orch fact for references footer.',
      sourceKind: 'submit',
      sourceRef: 't',
      confidence: 0.9,
    })
    indexer.close()

    const mockLlm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: vi.fn(async params => {
        if (params.systemPrompt?.includes('revise an existing')) {
          return {
            text: 'REVISED\n',
            stopReason: 'end_turn' as const,
            toolUses: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }
        return {
          text: 'INITIAL\n',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 2, outputTokens: 2 },
        }
      }),
    }

    const started = await startGenerationSession({
      baseDir,
      prompt: 'orch topic',
      config,
      deps: { llm: mockLlm },
    })
    const { sessionId } = started

    const qn = loadQuestionnaire('reference').length
    for (let i = 0; i < qn; i += 1) {
      await answerCurrent(baseDir, sessionId, `a${i}`)
    }

    const d1 = await produceInitialDraft({
      baseDir,
      sessionId,
      llm: mockLlm,
      factLimit: 5,
    })
    expect(d1.revision).toBe(1)
    const draftCalls = vi
      .mocked(mockLlm.call)
      .mock.calls.filter(c => (c[0]?.systemPrompt ?? '').includes('write KB markdown'))
    expect(draftCalls[0]?.[0]?.messages?.[0]?.content as string).toContain('KB facts')
    expect(draftCalls[0]?.[0]?.messages?.[0]?.content as string).toContain('orch fact')

    const d2 = await produceRevisedDraft({
      baseDir,
      sessionId,
      llm: mockLlm,
      feedback: 'tighten',
      factLimit: 5,
    })
    expect(d2.revision).toBe(2)
    expect(d2.diff).toContain('-INITIAL')
    expect(d2.diff).toContain('+REVISED')

    const writeDocument = vi.fn(async () => ({
      id: 'written-1',
      title: 'T',
      filePath: 'sqlite',
      createdAt: 'now',
      updatedAt: 'now',
    }))

    const out = await acceptDraft({
      baseDir,
      sessionId,
      deps: { documentWriter: { writeDocument } },
    })
    expect(out.document.id).toBe('written-1')
    expect(writeDocument).toHaveBeenCalledTimes(1)
    const arg = writeDocument.mock.calls[0]?.[0]
    expect(arg?.content).toContain('REVISED')
    expect(arg?.content).toContain('## References')
  })

  it('[TC-18] second revise user prompt lists prior reviewer feedback before latest instruction', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-orch-rev-'))
    tempDirs.push(baseDir)
    const config = {} as KbConfig

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'topic stacked feedback fact for revision flow.',
      sourceKind: 'submit',
      sourceRef: 't',
      confidence: 0.9,
    })
    indexer.close()

    const mockLlm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: vi.fn(async params => {
        if ((params.systemPrompt ?? '').includes('You revise an existing')) {
          return {
            text: 'REV\n',
            stopReason: 'end_turn' as const,
            toolUses: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }
        return {
          text: 'INIT\n',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 2, outputTokens: 2 },
        }
      }),
    }

    const started = await startGenerationSession({
      baseDir,
      prompt: 'topic',
      config,
      deps: { llm: mockLlm },
    })
    const { sessionId } = started
    const qn = loadQuestionnaire('reference').length
    for (let i = 0; i < qn; i += 1) {
      await answerCurrent(baseDir, sessionId, `a${i}`)
    }
    await produceInitialDraft({ baseDir, sessionId, llm: mockLlm, factLimit: 5 })
    await produceRevisedDraft({
      baseDir,
      sessionId,
      llm: mockLlm,
      feedback: 'first round',
      factLimit: 5,
    })
    await produceRevisedDraft({
      baseDir,
      sessionId,
      llm: mockLlm,
      feedback: 'second round',
      factLimit: 5,
    })

    const reviseCalls = vi
      .mocked(mockLlm.call)
      .mock.calls.filter(args => (args[0]?.systemPrompt ?? '').includes('You revise an existing'))
    expect(reviseCalls.length).toBe(2)
    const firstUser = reviseCalls[0]?.[0]?.messages?.[0]?.content as string
    const secondUser = reviseCalls[1]?.[0]?.messages?.[0]?.content as string
    expect(firstUser).not.toContain('Prior reviewer instructions')
    expect(secondUser).toContain('Prior reviewer instructions')
    expect(secondUser).toContain('1. first round')
    expect(secondUser).toContain('Latest reviewer instruction')
    expect(secondUser).toContain('second round')
  })

  it('[TC-19] Given user-defined sections, startGenerationSession is ready immediately and skips questionnaire', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-orch-sections-'))
    tempDirs.push(baseDir)
    const config = {} as KbConfig

    const mockLlm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'reference',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const started = await startGenerationSession({
      baseDir,
      prompt: 'Custom sections doc',
      config,
      deps: { llm: mockLlm },
      sections: [
        { name: 'Overview', description: 'High-level summary' },
        { name: 'API', description: 'Endpoint reference' },
      ],
    })

    expect(started.status).toBe('ready')
    expect(started.questionIndex).toBeNull()
    expect(started.question).toBeUndefined()
    // Exactly one LLM call: doc-type classification. Sections skip the questionnaire.
    expect(mockLlm.call).toHaveBeenCalledTimes(1)
  })

  it('[TC-20] Given user-defined sections, produceInitialDraft sends sections block not structured answers', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-orch-sectionsprompt-'))
    tempDirs.push(baseDir)
    const config = {} as KbConfig

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'background steps: custom doc generation with user sections.',
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
        text: 'SECTIONS_DRAFT\n',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 2, outputTokens: 2 },
      })),
    }

    const started = await startGenerationSession({
      baseDir,
      prompt: 'My custom doc',
      config,
      deps: { llm: mockLlm },
      sections: [
        { name: 'Background', description: 'Context for this document' },
        { name: 'Steps', description: 'What to do' },
      ],
    })

    await produceInitialDraft({ baseDir, sessionId: started.sessionId, llm: mockLlm, factLimit: 5 })

    const draftCall = vi.mocked(mockLlm.call).mock.calls.find(c =>
      (c[0]?.systemPrompt ?? '').includes('write KB markdown')
    )
    expect(draftCall).toBeDefined()
    const userMsg = draftCall?.[0]?.messages?.[0]?.content as string
    expect(userMsg).toContain('User-defined sections')
    expect(userMsg).toContain('1. Background')
    expect(userMsg).toContain('2. Steps')
    expect(userMsg).not.toContain('Structured answers')
  })

  it('[TC-21] Given no facts in KB, produceInitialDraft throws before calling draft LLM', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-orch-empty-'))
    tempDirs.push(baseDir)
    const config = {} as KbConfig
    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    ix.close()

    const mockLlm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'SHOULD_NOT_RUN',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const started = await startGenerationSession({
      baseDir,
      prompt: 'topic with no kb overlap zzzuniquezzz',
      config,
      deps: { llm: mockLlm },
    })
    const { sessionId } = started
    const qn = loadQuestionnaire('reference').length
    for (let i = 0; i < qn; i += 1) {
      await answerCurrent(baseDir, sessionId, `a${i}`)
    }

    await expect(
      produceInitialDraft({ baseDir, sessionId, llm: mockLlm, factLimit: 5 })
    ).rejects.toThrow(/no supporting facts/)
    // The single LLM call is doc-type classification at session start; no draft call happened.
    expect(mockLlm.call).toHaveBeenCalledTimes(1)
  })
})
