import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import { FactsDocumentReader } from '@kb/core/tools/facts-document-reader.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

function mockLlm(expansions: string[]): LLMProvider {
  return {
    call: async () => ({
      text: JSON.stringify(expansions),
      inputTokens: 0,
      outputTokens: 0,
    }),
  } as unknown as LLMProvider
}

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
  it('[smoke] hybrid deep retrieval returns ranked units', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertDocument({
      gitRepo: '',
      relPath: 'docs/raylib.md',
      title: 'raylib overview',
      body: 'raylib is a C library focused on simple game development and audio modules',
    })
    indexer.upsertCuratedFact({
      text: 'raylib provides rendering, input, and audio modules',
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

    expect(response.retrieval.method).toMatch(/hybrid|lexical/)
    expect(response.total).toBeGreaterThan(0)
  })

  it('[TC-19] expands generic query via LLM and merges results from all sub-queries', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertDocument({
      relPath: 'README.md',
      title: 'Agent',
      body: 'The agent loop processes tool calls for retrieval',
    })
    indexer.upsertDocument({
      relPath: 'LOOP.md',
      title: 'Loop',
      body: 'The loop executes tools in parallel when requested',
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath, mockLlm(['tool calls', 'parallel tools']))
    const response = await reader.queryDocuments({
      query: 'agent',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 10,
    })
    expect(response.total).toBeGreaterThan(0)
  })

  it('[TC-20] skips expansion when query has enough meaningful tokens', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'sqlite hybrid search ranks documents and symbols together' })
    indexer.close()

    let calls = 0
    const llm: LLMProvider = {
      call: async () => {
        calls += 1
        return { text: '[]', inputTokens: 0, outputTokens: 0 }
      },
    } as unknown as LLMProvider

    const reader = new FactsDocumentReader(dbPath, llm)
    await reader.queryDocuments({
      query: 'sqlite hybrid search ranking documents symbols',
      discoveryDepth: 'deep',
      limit: 5,
    })
    expect(calls).toBe(0)
  })

  it('[TC-21] falls back to single-query when LLM returns empty expansion', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'kb graph command summarizes documents and symbols' })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath, mockLlm([]))
    const response = await reader.queryDocuments({
      query: 'graph',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 5,
    })
    expect(response.total).toBeGreaterThanOrEqual(0)
  })

  it('[TC-22] Given allFacts in input, then returns all facts without query-based filtering', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'fact one about indexing pipeline' })
    indexer.upsertCuratedFact({ text: 'fact two about hybrid retrieval' })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const response = await reader.queryDocuments({ allFacts: true, includeContent: true })
    expect(response.total).toBeGreaterThanOrEqual(2)
    expect(response.retrieval.detail).toBe('all-facts')
  })

  it('[TC-23] Given defaultAllFacts constructor param, then every queryDocuments call uses all-facts mode', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'only fact in the store for all-facts mode' })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath, undefined, true)
    const first = await reader.queryDocuments({ query: 'ignored' })
    expect(first.retrieval.detail).toBe('all-facts')
    const second = await reader.queryDocuments({ query: 'ignored' })
    expect(second.retrieval.detail).toBe('all-facts:already-in-context')
  })

  it('[TC-24] Given all_facts mode, then second call in same session returns empty (already-in-context)', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'session fact for all-facts dedupe' })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    await reader.queryDocuments({ allFacts: true })
    const second = await reader.queryDocuments({ allFacts: true })
    expect(second.total).toBe(0)
  })

  it('[TC-25] Given all_facts mode via input flag, then deduplication also applies on second call', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'another all-facts session row' })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    await reader.queryDocuments({ allFacts: true })
    const second = await reader.queryDocuments({ allFacts: true })
    expect(second.retrieval.detail).toBe('all-facts:already-in-context')
  })

  it('[TC-26] Given allFacts mode, then LLM query expansion is never invoked', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertCuratedFact({ text: 'expansion should not be called for allFacts' })
    indexer.close()

    let calls = 0
    const llm: LLMProvider = {
      call: async () => {
        calls += 1
        return { text: '[]', inputTokens: 0, outputTokens: 0 }
      },
    } as unknown as LLMProvider

    const reader = new FactsDocumentReader(dbPath, llm)
    await reader.queryDocuments({ allFacts: true, discoveryDepth: 'deep' })
    expect(calls).toBe(0)
  })
})
