import type { LLMProvider } from '../core/types'
import type { QueryResult } from './facts-document-reader'

/** Minimum result count before LLM filtering is worth the extra call. */
const FILTER_MIN_RESULTS = 20

/** Fallback: keep at least this many facts even if LLM is aggressive. */
const FILTER_MIN_KEEP = 10

/**
 * Post-retrieval LLM relevance filter. Sends fact summaries to the LLM and
 * keeps only those rated relevant to the query.
 *
 * Enabled when KB_LLM_RELEVANCE_FILTER=true. Falls back silently to the
 * original list on errors or if filtering would leave too few facts.
 */
export async function filterRelevantFacts(
  llm: LLMProvider,
  query: string,
  results: QueryResult[]
): Promise<QueryResult[]> {
  if (results.length <= FILTER_MIN_RESULTS) return results

  const minKeep = Math.max(
    FILTER_MIN_KEEP,
    Math.ceil(results.length * 0.15)
  )

  // One line per fact: id|first 120 chars of title
  const factLines = results
    .map(r => `${r.metadata.id}|${(r.metadata.title ?? '').slice(0, 120)}`)
    .join('\n')

  try {
    const response = await llm.call({
      messages: [
        {
          role: 'user',
          content: [
            `Query: ${query}`,
            '',
            'Below are facts retrieved from a knowledge base. Return ONLY a JSON array of fact IDs that are relevant to answering the query.',
            'Include facts that directly address the query topic. Exclude facts about clearly unrelated topics.',
            'Return ONLY the JSON array, no explanation.',
            '',
            'Facts (id|summary):',
            factLines,
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 600,
    })

    const match = response.text.match(/\[[\s\S]*?\]/)
    if (!match) return results

    const keepIds = new Set<string>(JSON.parse(match[0]) as string[])
    const filtered = results.filter(r => keepIds.has(r.metadata.id))

    return filtered.length >= minKeep ? filtered : results
  } catch {
    return results
  }
}

export function shouldRunRelevanceFilter(results: QueryResult[]): boolean {
  return (
    process.env.KB_LLM_RELEVANCE_FILTER === 'true' &&
    results.length > FILTER_MIN_RESULTS
  )
}
