import { retrieveHybrid } from '../tools/hybrid-retriever'
import type { SqliteKbIndexer } from '../tools/sqlite-kb-index'

export interface SupportingFact {
  id: string
  factText: string
}

/**
 * Search the index for units supporting a doc-generate prompt.
 *
 * Uses the same hybrid retriever as `kb query`, so the grounding a generated doc gets is
 * the grounding a user asking the same question would get.
 */
export async function searchSupportingFacts(
  indexer: SqliteKbIndexer,
  query: string,
  limit = 20,
  options?: { excludeIds?: Set<string> }
): Promise<SupportingFact[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  await indexer.cacheQueryEmbedding(trimmed)
  const { units } = retrieveHybrid(indexer, {
    query: trimmed,
    limit,
    includeContent: true,
    ...(options?.excludeIds ? { excludeIds: options.excludeIds } : {}),
  })
  return units
    .filter(unit => unit.content)
    .map(unit => ({ id: unit.metadata.id, factText: unit.content ?? '' }))
}

/** Markdown block listing grounded facts for doc-generate LLM prompts. */
export function buildDocgenFactContext(facts: SupportingFact[]): string {
  if (facts.length === 0) {
    return 'KB facts (grounding):\n(none — do not invent repository facts.)'
  }
  const lines = facts.map(
    (f, i) => `${i + 1}. [${f.id}] ${f.factText.replace(/\r?\n/g, ' ').trim()}`
  )
  return [
    'KB facts (ground repository claims only with these; do not invent other facts):',
    ...lines,
  ].join('\n')
}
