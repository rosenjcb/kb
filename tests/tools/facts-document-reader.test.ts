import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LLMProvider } from '../../src/core/types'
import { FactsDocumentReader } from '../../src/tools/facts-document-reader'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

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
  it('[TC-40] uses iterative facts loop for deep discovery', async () => {
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
    expect(response.retrieval.detail).toContain('passes:')
    expect(response.retrieval.detail).toContain('stop:')
    expect(response.retrieval.detail).toContain('semantic:on')
    expect(response.retrieval.traceDetail).toContain('trace:')
    expect(response.retrieval.traceDetail).toContain('frontier=')
    expect(response.retrieval.checkpoints?.length).toBeGreaterThan(0)
    expect(response.total).toBeGreaterThan(0)
  })

  it('[TC-41] marks weak evidence after exhaustion without requiring chat-only deepen hints', async () => {
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

    expect(response.retrieval.clarificationQuestion).toBeFalsy()
    expect(response.retrieval.detail).toContain('stop:weak_evidence_after_exhaustion')
    expect(response.retrieval.checkpoints?.at(-1)?.nextAction).toBeTruthy()
  })

  it('[TC-42] continues expanding graph hops while novel concepts exist', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'alpha connects to beta in the controller graph',
      triplet: { subject: 'alpha', predicate: 'connects_to', object: 'beta' },
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'beta connects to gamma in the controller graph',
      triplet: { subject: 'beta', predicate: 'connects_to', object: 'gamma' },
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'gamma connects to delta in the controller graph',
      triplet: { subject: 'gamma', predicate: 'connects_to', object: 'delta' },
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const response = await reader.queryDocuments({
      query: 'alpha delta controller graph',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 5,
      surface: 'query',
    })

    expect(response.retrieval.detail).toContain('graph_hops:')
    expect(response.retrieval.checkpoints?.length).toBeGreaterThan(1)
  })

  it('[TC-43] expands generic query via LLM and merges results from all sub-queries', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'raylib is a simple C library for game development',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'raylib provides window management and input handling',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'raylib supports multiple platforms including Windows and Linux',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.close()

    const llm = mockLlm(['raylib overview description', 'raylib capabilities features'])
    const reader = new FactsDocumentReader(dbPath, llm)
    const response = await reader.queryDocuments({
      query: 'what is raylib',
      discoveryDepth: 'deep',
      includeContent: true,
      limit: 10,
      surface: 'query',
    })

    expect(response.retrieval.detail).toContain('expanded:2')
    expect(response.total).toBeGreaterThan(0)
  })

  it('[TC-44] skips expansion when query has enough meaningful tokens', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'raylib provides platform-specific rendering via backends',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.close()

    let llmCalled = false
    const llm: LLMProvider = {
      call: async () => {
        llmCalled = true
        return { text: '[]', inputTokens: 0, outputTokens: 0 }
      },
    } as unknown as LLMProvider

    const reader = new FactsDocumentReader(dbPath, llm)
    await reader.queryDocuments({
      query: 'how does raylib handle platform rendering backends',
      discoveryDepth: 'deep',
      limit: 5,
      surface: 'query',
    })

    expect(llmCalled).toBe(false)
  })

  it('[TC-45] falls back to single-query when LLM returns empty expansion', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({
      factText: 'raylib is a game development library',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.close()

    const llm = mockLlm([])
    const reader = new FactsDocumentReader(dbPath, llm)
    const response = await reader.queryDocuments({
      query: 'raylib',
      discoveryDepth: 'deep',
      limit: 5,
      surface: 'query',
    })

    expect(response.retrieval.detail).not.toContain('expanded:')
  })
})

describe('FactsDocumentReader — all_facts mode', () => {
  it('[TC-46] Given allFacts in input, then returns all facts without query-based filtering', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'fact about apples', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.upsertFact({ factText: 'fact about oranges', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.upsertFact({ factText: 'fact about bananas', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const response = await reader.queryDocuments({
      query: 'completely unrelated query xyz',
      allFacts: true,
      includeContent: true,
      limit: 5,
    })

    expect(response.results).toHaveLength(3)
    expect(response.retrieval.detail).toBe('all-facts')
    const texts = response.results.map(r => r.content ?? '')
    expect(texts.some(t => t.includes('apples'))).toBe(true)
    expect(texts.some(t => t.includes('oranges'))).toBe(true)
    expect(texts.some(t => t.includes('bananas'))).toBe(true)
  })

  it('[TC-47] Given defaultAllFacts constructor param, then every queryDocuments call uses all-facts mode', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'first fact', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.upsertFact({ factText: 'second fact', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath, undefined, true)
    const response = await reader.queryDocuments({
      query: 'nothing matches this',
      includeContent: true,
    })

    expect(response.results).toHaveLength(2)
    expect(response.retrieval.detail).toBe('all-facts')
  })

  it('[TC-48] Given all_facts mode, then second call in same session returns empty (already-in-context)', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'some fact', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath, undefined, true)

    const first = await reader.queryDocuments({ query: 'anything', includeContent: true })
    const second = await reader.queryDocuments({ query: 'anything', includeContent: true })

    expect(first.results).toHaveLength(1)
    expect(first.retrieval.detail).toBe('all-facts')
    expect(second.results).toHaveLength(0)
    expect(second.retrieval.detail).toBe('all-facts:already-in-context')
  })

  it('[TC-49] Given all_facts mode via input flag, then deduplication also applies on second call', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'dedupe test fact', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const first = await reader.queryDocuments({ query: 'test', allFacts: true, includeContent: true })
    const second = await reader.queryDocuments({ query: 'test', allFacts: true, includeContent: true })

    expect(first.results).toHaveLength(1)
    expect(second.results).toHaveLength(0)
    expect(second.retrieval.detail).toBe('all-facts:already-in-context')
  })

  it('[TC-50] Given allFacts mode, then LLM query expansion is never invoked', async () => {
    const dbPath = await createDbPath()
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'some expandable fact', sourceKind: 'submit', sourceRef: 'test', confidence: 0.9 })
    indexer.close()

    let llmCalled = false
    const llm: LLMProvider = {
      call: async () => {
        llmCalled = true
        return { text: '["expansion1"]', inputTokens: 0, outputTokens: 0 }
      },
    } as unknown as LLMProvider

    const reader = new FactsDocumentReader(dbPath, llm, true)
    await reader.queryDocuments({ query: 'raylib', discoveryDepth: 'deep', surface: 'query' })

    expect(llmCalled).toBe(false)
  })
})
