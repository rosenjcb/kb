import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FactsDocumentReader } from '../../src/tools/facts-document-reader'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-facts-reader-'))
  tempDirs.push(dir)
  return path.join(dir, 'kb-index.sqlite')
}

describe('FactsDocumentReader', () => {
  it('uses iterative facts loop for deep discovery', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'raylib is a C library focused on simple game development',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'raylib provides rendering, input, and audio modules',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const response = await reader.queryDocuments({
      query: 'What is raylib and what modules does it provide?',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 5,
      surface: 'query',
    })

    expect(response.retrieval.method).toBe('hybrid')
    expect(response.retrieval.detail).toContain('facts-loop')
    expect(response.total).toBeGreaterThan(0)
  })

  it('emits clarification question for chat when deep loop stays insufficient', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'build pipeline runs on every push',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.7,
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const response = await reader.queryDocuments({
      query: 'How do we guarantee secure release signing in production?',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 5,
      surface: 'chat',
    })

    expect(response.retrieval.clarificationQuestion).toBeTruthy()
  })
})
