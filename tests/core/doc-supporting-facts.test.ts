import { describe, expect, it, vi } from 'vitest'
import { buildDocgenFactContext, searchSupportingFacts } from '@kb/core/core/doc-supporting-facts.js'
import type { FactRow } from '@kb/core/tools/sqlite-kb-index.js'

const makeRow = (overrides: Partial<FactRow>): FactRow =>
  ({
    id: 'fact-abc',
    fact_text: 'Sample fact',
    normalized_text: 'sample fact',
    source_kind: 'submit',
    source_ref: null,
    lane_id: 'general',
    confidence: 0.8,
    supersedes_fact_id: null,
    tombstoned_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as FactRow

function makeIndexer(rows: FactRow[] = []) {
  return {
    searchFacts: vi.fn(() => rows),
    searchFactsByConceptFrontier: vi.fn(() => []),
    searchFactsByConcepts: vi.fn(() => []),
    semanticFactScores: vi.fn(() => new Map()),
    listFactConcepts: vi.fn(() => []),
    expandNeighborConcepts: vi.fn(() => []),
    getFactNeighbors: vi.fn(() => []),
    getGraphEdgesForFacts: vi.fn(() => []),
    listCrossRepoLinks: vi.fn(() => []),
  }
}

describe('searchSupportingFacts', () => {
  it('[TC-41] Given a query, then forwards to indexer.searchFacts and projects id/factText', async () => {
    const rows = [
      makeRow({ id: 'fact-1', fact_text: 'First fact' }),
      makeRow({ id: 'fact-2', fact_text: 'Second fact' }),
    ]
    const indexer = makeIndexer(rows)

    const result = await searchSupportingFacts(indexer as never, 'session orchestrator', 5)

    expect(indexer.searchFacts).toHaveBeenCalled()
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['fact-1', 'fact-2']))
  })

  it('[TC-42] Given an empty query, then returns no results without calling the indexer', async () => {
    const indexer = makeIndexer()
    expect(await searchSupportingFacts(indexer as never, '   ', 10)).toEqual([])
    expect(indexer.searchFacts).not.toHaveBeenCalled()
  })

  it('[TC-43] Given no rows, then returns empty array', async () => {
    const indexer = makeIndexer([])
    expect(await searchSupportingFacts(indexer as never, 'topic', 10)).toEqual([])
  })

  it('[TC-44] Given no explicit limit, then defaults to 20', async () => {
    const indexer = makeIndexer([])
    await searchSupportingFacts(indexer as never, 'topic')
    expect(indexer.searchFacts).toHaveBeenCalled()
  })
})

describe('buildDocgenFactContext', () => {
  it('[TC-45] Given facts, then formats numbered id lines', () => {
    const text = buildDocgenFactContext([
      { id: 'fact-aaaaaaaaaaaaaaaa', factText: 'Alpha claim.' },
      { id: 'fact-bbbbbbbbbbbbbbbb', factText: 'Beta\nline' },
    ])
    expect(text).toContain('KB facts')
    expect(text).toContain('[fact-aaaaaaaaaaaaaaaa] Alpha claim.')
    expect(text).toContain('[fact-bbbbbbbbbbbbbbbb] Beta line')
  })

  it('[TC-46] Given empty facts, then returns refusal hint block', () => {
    expect(buildDocgenFactContext([])).toContain('none')
  })
})
