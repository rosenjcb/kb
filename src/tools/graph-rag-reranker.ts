import type { ReadDocumentsResultItem } from '../cli/intent-cli'
import type { LLMProvider } from '../core/types'
import type { CodeGraphStore } from './code-graph-store'
import type { KbGraphWriter } from './kb-graph-writer'
import { toGraphQuerySlugs } from './graph-query-expansion'

const MAX_ENTITIES = 8
const MAX_NEIGHBOR_TERMS = 24

/**
 * Ask the LLM to extract technical entity names from the query.
 * This bridges semantic gaps that slug-matching can't: "AST graph generation"
 * → ["TsMorphIndexer", "code-graph-indexer", "TypeScript compiler"].
 */
export async function llmExtractQueryEntities(
  query: string,
  llmProvider: LLMProvider
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
  } catch {
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
export async function rerankByGraphConnectivity(
  results: ReadDocumentsResultItem[],
  queryEntities: string[],
  graphWriter: KbGraphWriter,
  codeStore?: CodeGraphStore
): Promise<ReadDocumentsResultItem[]> {
  if (queryEntities.length === 0 || results.length < 2) return results

  try {
    const entitySlugs = queryEntities.flatMap(e => toGraphQuerySlugs(e))
    const neighborTerms = await graphWriter.expandQuery(entitySlugs)

    let codeSymbols: string[] = []
    if (codeStore) {
      try {
        const nodes = codeStore.findCodeSymbolsByName(entitySlugs, 12)
        codeSymbols = nodes.map(n => n.name.toLowerCase())
      } catch {
        // best-effort
      }
    }

    const neighborSet = new Set<string>([
      ...queryEntities.map(e => e.toLowerCase()),
      ...neighborTerms.slice(0, MAX_NEIGHBOR_TERMS).map(t => t.toLowerCase()),
      ...codeSymbols,
    ])

    if (neighborSet.size === 0) return results

    const scored = results.map((item, originalIndex) => {
      const searchable = [
        item.content ?? '',
        ...(item.graphEvidence ?? []),
      ].join(' ').toLowerCase()

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
