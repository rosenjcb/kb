import type { DatabaseSync } from 'node:sqlite'
import type { ReadDocumentsResultItem } from '@kb/core/query/intent-cli.js'
import { type LLMFailure, toLLMFailure } from '../core/llm-error.js'
import type { LLMProvider } from '../core/types'
import { expandQueryWithGraph, toGraphQuerySlugs } from './graph-query-expansion'

const MAX_ENTITIES = 8
const MAX_NEIGHBOR_TERMS = 24

/**
 * Ask the LLM to extract technical entity names from the query.
 * This bridges semantic gaps that slug-matching can't: "AST graph generation"
 * → ["TreeSitterIndexer", "tree-sitter-indexer", "TypeScript compiler"].
 */
export async function llmExtractQueryEntities(
  query: string,
  llmProvider: LLMProvider,
  onFailure?: (failure: LLMFailure) => void
): Promise<string[]> {
  try {
    const completion = await llmProvider.call({
      messages: [
        {
          role: 'user',
          content: [
            'Extract 3-8 technical entity names from this query.',
            'Return ONLY a JSON array of strings — class names, file names, system components, or specific technical terms that would appear in a codebase.',
            'No explanation, no markdown fences, just the array.',
            '',
            `Query: ${query}`,
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 120,
    })
    const text = completion.text.trim()
    const match = text.match(/\[[\s\S]*?\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0]) as unknown[]
    return parsed
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
      .slice(0, MAX_ENTITIES)
  } catch (error) {
    // Extraction is best-effort — an empty list just means no rerank. Report the cause so a
    // provider outage is not silently filed as "the query had no entities".
    onFailure?.(toLLMFailure('graph-rerank', error, llmProvider.name))
    return []
  }
}

/**
 * Re-rank retrieved facts by graph connectivity to the LLM-extracted query entities.
 *
 * For each result, we score how many graph neighborhood terms appear in its
 * content and graphEvidence hints. Results with stronger graph connections to
 * the query entities rise; unrelated duplicates stay put. Ties preserve original
 * retrieval order (stable sort).
 */
export function rerankByGraphConnectivity(
  results: ReadDocumentsResultItem[],
  queryEntities: string[],
  db: DatabaseSync
): ReadDocumentsResultItem[] {
  if (queryEntities.length === 0 || results.length < 2) return results

  try {
    const entitySlugs = queryEntities.flatMap(e => toGraphQuerySlugs(e))
    const expandedQuery = expandQueryWithGraph(entitySlugs.join(' '), db)
    const neighborTerms = expandedQuery
      .split(/\s+/)
      .filter(t => t.length > 2)
      .map(t => t.toLowerCase())

    const neighborSet = new Set<string>([
      ...queryEntities.map(e => e.toLowerCase()),
      ...neighborTerms.slice(0, MAX_NEIGHBOR_TERMS),
    ])

    if (neighborSet.size === 0) return results

    const scored = results.map((item, originalIndex) => {
      const searchable = [item.content ?? '', ...(item.graphEvidence ?? [])].join(' ').toLowerCase()

      let score = 0
      for (const term of neighborSet) {
        if (term.length > 2 && searchable.includes(term)) score++
      }

      return { item, score, originalIndex }
    })

    scored.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.originalIndex - b.originalIndex
    )

    return scored.map(s => s.item)
  } catch {
    return results
  }
}
