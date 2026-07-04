import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocsGenerateCommand, runDocsGenerate } from '@kb/client/cli/docs-generate-cli.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { loadQuestionnaire } from '@kb/core/core/doc-questionnaire.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-docs-generate-'))
  tempDirs.push(dir)
  return dir
}

function makeMockLlm(): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    supportsStreaming: false,
    call: vi.fn(async params => {
      if (params.systemPrompt?.includes('Pick exactly one')) {
        return {
          text: 'reference',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      }
      return {
        text: '## Draft\n\nGenerated body line.\n',
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 2, outputTokens: 2 },
      }
    }),
  }
}

describe('docs generate flow', () => {
  it('[TC-186] Given full questionnaire answered, finalize writes document with doc type', async () => {
    const baseDir = await createTempBase()
    const mockLlm = makeMockLlm()
    const config = {} as KbConfig

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'auth overview: KB supports doc generation workflow.',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })

    const start = parseDocsGenerateCommand([
      'auth overview',
      '--type',
      'reference',
      '--base',
      baseDir,
    ])
    const startOut = (await runDocsGenerate(start, baseDir, config, {
      llm: mockLlm,
    })) as { sessionId: string }
    const sessionId = startOut.sessionId
    expect(sessionId).toBeTruthy()

    const qCount = loadQuestionnaire('reference').length
    for (let i = 0; i < qCount; i += 1) {
      const resume = parseDocsGenerateCommand([
        '--resume',
        sessionId,
        '--answer',
        `answer-${i}`,
        '--base',
        baseDir,
      ])
      await runDocsGenerate(resume, baseDir, config, { llm: mockLlm })
    }

    const fin = parseDocsGenerateCommand(['--resume', sessionId, '--finalize', '--base', baseDir])
    const finOut = (await runDocsGenerate(fin, baseDir, config, {
      llm: mockLlm,
    })) as {
      status: string
      revision: number
      supportingFactCount: number
    }

    expect(finOut.status).toBe('awaiting_review')
    expect(finOut.revision).toBe(1)
    expect(finOut.supportingFactCount).toBeGreaterThanOrEqual(1)

    const acc = parseDocsGenerateCommand(['--resume', sessionId, '--accept', '--base', baseDir])
    const accOut = (await runDocsGenerate(acc, baseDir, config, {
      llm: mockLlm,
    })) as {
      document: { id: string; title: string }
      revision: number
    }

    const content = indexer.getDocumentContent(accOut.document.id) ?? ''
    expect(content).toContain('Type: reference')
    expect(content).toContain('Generated body line')
    expect(content).toContain('## References')
    expect(content).toContain('fact://')

    expect(mockLlm.call).toHaveBeenCalledTimes(1)
    indexer.close()
  })
})
