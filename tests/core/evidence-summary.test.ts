import { describe, expect, it } from 'vitest'
import {
  buildEvidenceSummaryParts,
  formatEvidenceSummaryHeader,
} from '@kb/core/core/evidence-summary.js'

describe('evidence-summary', () => {
  it('[TC-56] Given mixed doc and code facts, then header summarizes count, mix, themes, and leads', () => {
    const header = formatEvidenceSummaryHeader({
      results: [
        {
          metadata: {
            id: 'fact-table',
            title: 'Language | Extensions | Code-graph (AST)',
            tags: ['import_doc', 'init', 'code-graph', 'fact'],
          },
        },
        {
          metadata: {
            id: 'fact-ts',
            title: 'TsMorphIndexer (code-graph-indexer.ts)',
            tags: ['import_doc', 'code-graph', 'fact'],
          },
        },
        {
          metadata: {
            id: 'fact-export',
            title: 'expandQueryWithGraph exported from graph-query-expansion.ts',
            tags: ['import_code', 'code-graph', 'fact'],
          },
        },
      ],
      retrieval: {
        detail: 'facts-loop;passes:24;graph_hops:20;ponds:6;stop:budget_exhausted;semantic:on',
        checkpoints: [{ stage: 'pass_24', status: 'stop', confidence: 0.71 }],
      },
    })

    expect(header).toContain('3 facts → LLM (full text)')
    expect(header).toContain('mix: 2 doc · 1 code')
    expect(header).toContain('themes: code-graph, init')
    expect(header).toContain('leads: Language | Extensions | Code-graph (AST)')
    expect(header).toContain('walk: 24p/20h/6 ponds')
    expect(header).toContain('stop: budget_exhausted')
    expect(header).toContain('conf: 0.71')
  })

  it('[TC-57] Given empty results, then header is omitted', () => {
    expect(formatEvidenceSummaryHeader({ results: [] })).toBeUndefined()
  })

  it('[TC-58] Given homogenous source kind, then mix uses all-doc shorthand', () => {
    const parts = buildEvidenceSummaryParts({
      results: [
        { metadata: { title: 'A', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'B', tags: ['import_doc', 'fact'] } },
      ],
    })
    expect(parts?.sourceMix).toBe('mix: all doc')
  })

  it('[TC-59] Given duplicate lead titles, then leads are deduped', () => {
    const parts = buildEvidenceSummaryParts({
      results: [
        { metadata: { title: 'TsMorphIndexer', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'TsMorphIndexer', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'TreeSitterIndexer', tags: ['import_doc', 'fact'] } },
      ],
    })
    expect(parts?.leads).toEqual(['TsMorphIndexer', 'TreeSitterIndexer'])
  })
})
