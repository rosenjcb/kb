import { describe, expect, it } from 'vitest'
import {
  buildEvidenceSummaryParts,
  formatEvidenceSummaryHeader,
} from '@kb/core/core/evidence-summary.js'

describe('evidence-summary', () => {
  it('[TC-WX2Q] Given mixed doc and code facts, then header summarizes count, mix, themes, and leads', () => {
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
            title: 'CodeGraphWalker (code-graph-walker.ts)',
            tags: ['import_doc', 'code-graph', 'fact'],
          },
        },
        {
          metadata: {
            id: 'fact-export',
            title: 'codeSymbolToUnit exported from hybrid-retriever.ts',
            tags: ['import_code', 'code-graph', 'fact'],
          },
        },
      ],
      retrieval: {
        detail: 'hybrid:docs=120,symbols=80,facts=0,hops=6;expanded:3',
        checkpoints: [{ stage: 'pass_24', status: 'stop', evidence: 'moderate' }],
      },
    })

    expect(header).toContain('3 facts → LLM (full text)')
    expect(header).toContain('mix: 2 doc · 1 code')
    expect(header).toContain('themes: code-graph, init')
    expect(header).toContain('leads: Language | Extensions | Code-graph (AST)')
    expect(header).toContain('retrieval: 120 docs · 80 sym · 6 hops (+3 expanded)')
    expect(header).toContain('evidence: moderate')
  })

  it('[TC-9UBM] Given empty results, then header is omitted', () => {
    expect(formatEvidenceSummaryHeader({ results: [] })).toBeUndefined()
  })

  it('[TC-WS0E] Given homogenous source kind, then mix uses all-doc shorthand', () => {
    const parts = buildEvidenceSummaryParts({
      results: [
        { metadata: { title: 'A', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'B', tags: ['import_doc', 'fact'] } },
      ],
    })
    expect(parts?.sourceMix).toBe('mix: all doc')
  })

  it('[TC-RF7O] Given duplicate lead titles, then leads are deduped', () => {
    const parts = buildEvidenceSummaryParts({
      results: [
        { metadata: { title: 'CodeGraphWalker', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'CodeGraphWalker', tags: ['import_doc', 'fact'] } },
        { metadata: { title: 'TreeSitterIndexer', tags: ['import_doc', 'fact'] } },
      ],
    })
    expect(parts?.leads).toEqual(['CodeGraphWalker', 'TreeSitterIndexer'])
  })
})
