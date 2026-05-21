import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  assignFactsToCategoryIds,
  inferFactCategories,
  type FactCategoryDefinitionInput,
} from '../../src/core/fact-categories'

type MockPayload = {
  mode?: string
  facts?: Array<{ id: string }>
  categories?: Array<{ id: string }>
  threshold?: number
  force_assign?: boolean
}

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn((_bin: string, _args: string[], opts: { input?: string } = {}) => {
      const payload = JSON.parse(opts.input ?? '{}') as MockPayload
      if (payload.mode === 'discover' || payload.mode === 'discover_and_assign') {
        const facts = payload.facts ?? []
        const categories = facts.length >= 2
          ? [
              {
                name: 'Retrieval Query',
                description: 'Facts about retrieval query',
                representative_terms: ['retrieval', 'query'],
                centroid_vector: Array.from({ length: 8 }, () => 0.1),
                fact_ids: facts.slice(0, Math.ceil(facts.length / 2)).map((f) => f.id),
              },
              {
                name: 'Init Index',
                description: 'Facts about init index',
                representative_terms: ['init', 'index'],
                centroid_vector: Array.from({ length: 8 }, () => 0.2),
                fact_ids: facts.slice(Math.ceil(facts.length / 2)).map((f) => f.id),
              },
            ]
          : []
        if (payload.mode === 'discover') return JSON.stringify({ categories })
        const assignments = (payload.facts ?? []).map((f, i) => ({
          fact_id: f.id,
          assignments: [{ category_id: categories[i % 2]?.name ? `category-${categories[i % 2]?.representative_terms[0]}` : 'category-retrieval-query', score: 0.8 }],
        }))
        return JSON.stringify({ categories, assignments })
      }
      if (payload.mode === 'assign') {
        const cats = payload.categories ?? []
        const threshold = payload.threshold ?? 0.72
        const forceAssign = payload.force_assign ?? false
        // Simulate zero similarity for facts whose text has no overlap with category text
        // by returning no matches when threshold is high and the fact text is "unrelated"
        const assignments = (payload.facts ?? []).map((f) => {
          const isUnrelated = (f as { id: string; text?: string }).text?.includes('unrelated') ?? false
          const aboveThreshold = cats.slice(0, 1).map((c) => ({ category_id: c.id, score: 0.8 }))
          if (isUnrelated && threshold > 0.5) {
            // simulate zero cosine similarity — no matches above threshold
            if (!forceAssign) return { fact_id: f.id, assignments: [] }
            // force_assign: return best match with score 0
            return { fact_id: f.id, assignments: [{ category_id: cats[0]?.id ?? 'cat-1', score: 0 }] }
          }
          return { fact_id: f.id, assignments: aboveThreshold }
        })
        return JSON.stringify({ assignments })
      }
      return JSON.stringify({})
    }),
  }
})

describe('fact-categories', () => {
  it('infers reusable project categories from related facts', () => {
    const categories = inferFactCategories([
      {
        id: 'f1',
        fact_text: 'kb query retrieves facts from sqlite and expands searches with graph traversal',
        source_kind: 'submit',
        subject: 'kb query',
        predicate: 'retrieves_from',
        object: 'sqlite',
      },
      {
        id: 'f2',
        fact_text: 'query expansion broadens retrieval by exploring connected concepts',
        source_kind: 'submit',
        subject: 'query expansion',
        predicate: 'broadens',
        object: 'retrieval',
      },
      {
        id: 'f3',
        fact_text: 'kb init segments markdown into facts before indexing the base',
        source_kind: 'submit',
        subject: 'kb init',
        predicate: 'segments',
        object: 'markdown facts',
      },
      {
        id: 'f4',
        fact_text: 'init writes discovered facts into the sqlite knowledge base',
        source_kind: 'submit',
        subject: 'init',
        predicate: 'writes',
        object: 'knowledge base',
      },
    ])

    expect(categories.length).toBeGreaterThan(0)
    expect(categories.some(category => category.factIds.length >= 2)).toBe(true)
    expect(categories.some(category => category.representativeTerms.length > 0)).toBe(true)
  })

  it('assigns facts to one or more accepted categories by semantic similarity', () => {
    const categories: FactCategoryDefinitionInput[] = [
      {
        id: 'category-retrieval',
        name: 'Retrieval',
        description: 'Facts about retrieval',
        status: 'accepted',
        createdBy: 'system',
        representativeTerms: ['retrieval', 'query', 'graph'],
        centroidVector: Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 0.1 : 0.2)),
      },
      {
        id: 'category-init',
        name: 'Init',
        description: 'Facts about init',
        status: 'accepted',
        createdBy: 'system',
        representativeTerms: ['init', 'scan', 'index'],
        centroidVector: Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 0.2 : 0.1)),
      },
    ]

    const assignments = assignFactsToCategoryIds(
      [
        {
          id: 'f1',
          fact_text: 'kb query and retrieval use graph traversal for search',
          subject: 'kb query',
          predicate: 'uses',
          object: 'graph traversal',
        },
        {
          id: 'f2',
          fact_text: 'kb init scans the repo and indexes facts',
          subject: 'kb init',
          predicate: 'indexes',
          object: 'facts',
        },
      ],
      categories,
      0
    )

    expect(assignments.get('f1')?.length).toBeGreaterThan(0)
    expect(assignments.get('f2')?.length).toBeGreaterThan(0)
  })

  it('with forceAssign=false, facts with no vocabulary overlap are left unassigned', () => {
    const categories: FactCategoryDefinitionInput[] = [
      {
        id: 'category-tui',
        name: 'TUI',
        description: 'Facts about the TUI interface',
        status: 'accepted',
        createdBy: 'user',
        representativeTerms: ['tui', 'interface', 'cli'],
        centroidVector: [],
      },
    ]

    const assignments = assignFactsToCategoryIds(
      [{ id: 'f-unrelated', fact_text: 'unrelated zephyr content', subject: '', predicate: '', object: '' }],
      categories,
      0.72,
      false
    )

    expect(assignments.get('f-unrelated')).toBeUndefined()
  })

  it('with forceAssign=true (default), facts with no vocabulary overlap are still assigned to nearest category', () => {
    const categories: FactCategoryDefinitionInput[] = [
      {
        id: 'category-tui',
        name: 'TUI',
        description: 'Facts about the TUI interface',
        status: 'accepted',
        createdBy: 'user',
        representativeTerms: ['tui', 'interface', 'cli'],
        centroidVector: [],
      },
    ]

    const assignments = assignFactsToCategoryIds(
      [{ id: 'f-unrelated', fact_text: 'unrelated zephyr content', subject: '', predicate: '', object: '' }],
      categories,
      0.72
      // forceAssign defaults to true
    )

    expect(assignments.get('f-unrelated')?.length).toBeGreaterThan(0)
    expect(assignments.get('f-unrelated')?.[0].categoryId).toBe('category-tui')
  })

  it('passes force_assign flag in payload to python', () => {
    type SpyExec = { mockClear(): void; mock: { calls: Array<[unknown, unknown, { input: string }]> } }
    const spy = execFileSync as unknown as SpyExec
    spy.mockClear()

    const categories: FactCategoryDefinitionInput[] = [
      {
        id: 'category-x',
        name: 'X',
        description: 'X',
        status: 'accepted',
        createdBy: 'user',
        representativeTerms: [],
        centroidVector: [],
      },
    ]
    assignFactsToCategoryIds(
      [{ id: 'f1', fact_text: 'some fact', subject: '', predicate: '', object: '' }],
      categories,
      0.3,
      true
    )

    const call = spy.mock.calls[0]
    const payload = JSON.parse(call[2].input) as MockPayload
    expect(payload.force_assign).toBe(true)
    expect(payload.threshold).toBe(0.3)
  })
})
