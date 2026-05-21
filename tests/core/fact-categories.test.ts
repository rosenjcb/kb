import { describe, expect, it, vi } from 'vitest'
import {
  assignFactsToCategoryIds,
  inferFactCategories,
  type FactCategoryDefinitionInput,
} from '../../src/core/fact-categories'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_, args: string[]) => {
    const payload = JSON.parse(args[args.length - 1] ?? '{}')
    return JSON.stringify(payload)
  }),
}))

// Override execFileSync to read from stdin instead — the real code pipes via input option
vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn((_bin: string, _args: string[], opts: { input?: string } = {}) => {
      const payload = JSON.parse(opts.input ?? '{}') as { mode?: string; facts?: Array<{ id: string }>; categories?: Array<{ id: string }> }
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
        const assignments = (payload.facts ?? []).map((f) => ({
          fact_id: f.id,
          assignments: cats.slice(0, 1).map((c) => ({ category_id: c.id, score: 0.8 })),
        }))
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
})
