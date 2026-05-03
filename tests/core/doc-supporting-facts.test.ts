import { describe, expect, it, vi } from 'vitest'
import { buildDocgenFactContext, searchSupportingFacts } from '../../src/core/doc-supporting-facts'
import type { FactRow } from '../../src/tools/sqlite-kb-index'

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

describe('searchSupportingFacts', () => {
  it('Given a query, then forwards to indexer.searchFacts and projects id/factText', () => {
    const searchFacts = vi.fn(() => [
      makeRow({ id: 'fact-1', fact_text: 'First fact' }),
      makeRow({ id: 'fact-2', fact_text: 'Second fact' }),
    ])

    const result = searchSupportingFacts({ searchFacts }, 'session orchestrator', 5)

    expect(searchFacts).toHaveBeenCalledWith('session orchestrator', 5)
    expect(result).toEqual([
      { id: 'fact-1', factText: 'First fact' },
      { id: 'fact-2', factText: 'Second fact' },
    ])
  })

  it('Given an empty query, then returns no results without calling the indexer', () => {
    const searchFacts = vi.fn()
    expect(searchSupportingFacts({ searchFacts }, '   ', 10)).toEqual([])
    expect(searchFacts).not.toHaveBeenCalled()
  })

  it('Given no rows, then returns empty array', () => {
    const searchFacts = vi.fn(() => [])
    expect(searchSupportingFacts({ searchFacts }, 'topic', 10)).toEqual([])
  })

  it('Given no explicit limit, then defaults to 20', () => {
    const searchFacts = vi.fn(() => [])
    searchSupportingFacts({ searchFacts }, 'topic')
    expect(searchFacts).toHaveBeenCalledWith('topic', 20)
  })
})

describe('buildDocgenFactContext', () => {
  it('Given facts, then formats numbered id lines', () => {
    const text = buildDocgenFactContext([
      { id: 'fact-aaaaaaaaaaaaaaaa', factText: 'Alpha claim.' },
      { id: 'fact-bbbbbbbbbbbbbbbb', factText: 'Beta\nline' },
    ])
    expect(text).toContain('KB facts')
    expect(text).toContain('[fact-aaaaaaaaaaaaaaaa] Alpha claim.')
    expect(text).toContain('[fact-bbbbbbbbbbbbbbbb] Beta line')
  })

  it('Given empty facts, then returns refusal hint block', () => {
    expect(buildDocgenFactContext([])).toContain('none')
  })
})
