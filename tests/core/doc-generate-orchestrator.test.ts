import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KbConfig } from '../../src/cli/kb-config'
import {
  acceptDraft,
  answerCurrent,
  produceInitialDraft,
  produceRevisedDraft,
  startGenerationSession,
} from '../../src/core/doc-generate-orchestrator'
import { loadQuestionnaire } from '../../src/core/doc-questionnaire'
import type { LLMProvider } from '../../src/core/types'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('doc-generate-orchestrator', () => {
  it('Given ready session, produceInitialDraft then reject then accept writes once', async () => {
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
      type: 'reference',
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
})
