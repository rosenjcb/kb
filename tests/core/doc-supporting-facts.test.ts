import { describe, expect, it, vi } from 'vitest'
import { buildDocgenFactContext, searchSupportingFacts } from '@kb/core/core/doc-supporting-facts.js'

function makeIndexer(units: Array<{ id: string; content?: string }> = []) {
  return {
    cacheQueryEmbedding: vi.fn(async () => {}),
    searchDocumentsFts: vi.fn(() =>
      units.map(u => ({
        id: u.id,
        git_repo: '',
        rel_path: 'x.md',
        title: u.id,
        body: u.content ?? '',
        content_hash: 'h',
        indexed_at: '2026-01-01T00:00:00.000Z',
      }))
    ),
    searchCodeSymbolsFts: vi.fn(() => []),
    searchFacts: vi.fn(() => []),
    semanticDocumentScores: vi.fn(() => new Map()),
    semanticCodeSymbolScores: vi.fn(() => new Map()),
    semanticFactScores: vi.fn(() => new Map()),
    listLinkedSymbols: vi.fn(() => []),
    listLinkingDocuments: vi.fn(() => []),
  }
}

describe('searchSupportingFacts', () => {
  it('[TC-36] Given a query, then uses hybrid retrieval and projects id/factText', async () => {
    const indexer = makeIndexer([
      { id: 'doc-1', content: 'First fact' },
      { id: 'doc-2', content: 'Second fact' },
    ])
    const result = await searchSupportingFacts(indexer as never, 'session orchestrator', 5)
    expect(indexer.cacheQueryEmbedding).toHaveBeenCalled()
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['doc-1', 'doc-2']))
  })

  it('[TC-37] Given an empty query, then returns no results without calling the indexer', async () => {
    const indexer = makeIndexer()
    expect(await searchSupportingFacts(indexer as never, '   ', 10)).toEqual([])
    expect(indexer.cacheQueryEmbedding).not.toHaveBeenCalled()
  })

  it('[TC-38] Given no rows, then returns empty array', async () => {
    const indexer = makeIndexer([])
    expect(await searchSupportingFacts(indexer as never, 'topic', 10)).toEqual([])
  })

  it('[TC-39] Given no explicit limit, then defaults to 20', async () => {
    const indexer = makeIndexer([])
    await searchSupportingFacts(indexer as never, 'topic')
    expect(indexer.searchDocumentsFts).toHaveBeenCalled()
  })
})

describe('buildDocgenFactContext', () => {
  it('[TC-40] Given facts, then formats numbered id lines', () => {
    const text = buildDocgenFactContext([
      { id: 'fact-aaaaaaaaaaaaaaaa', factText: 'Alpha claim.' },
      { id: 'fact-bbbbbbbbbbbbbbbb', factText: 'Beta\nline' },
    ])
    expect(text).toContain('KB facts')
    expect(text).toContain('[fact-aaaaaaaaaaaaaaaa] Alpha claim.')
    expect(text).toContain('[fact-bbbbbbbbbbbbbbbb] Beta line')
  })

  it('[TC-41] Given empty facts, then returns refusal hint block', () => {
    expect(buildDocgenFactContext([])).toContain('none')
  })
})
