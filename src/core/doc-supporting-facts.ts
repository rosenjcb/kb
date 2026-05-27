import { FactsQueryResearchOrchestrator } from '../tools/facts-query-research-orchestrator'
import type { SqliteKbIndexer } from '../tools/sqlite-kb-index'

export interface SupportingFact {
  id: string
  factText: string
}

/**
 * Search the facts store for entries supporting a doc-generate prompt.
 *
 * Uses the same FactsQueryResearchOrchestrator pipeline as kb query:
 * graph hops, concept expansion, semantic scoring, and source-kind quotas all apply.
 */
export function searchSupportingFacts(
  indexer: SqliteKbIndexer,
  query: string,
  limit = 20,
  options?: { excludeIds?: Set<string> }
): SupportingFact[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const orchestrator = new FactsQueryResearchOrchestrator(indexer)
  const response = orchestrator.run({
    query: trimmed,
    limit,
    surface: 'query',
    includeContent: true,
    excludeIds: options?.excludeIds,
  })
  return response.results
    .filter(r => r.content)
    .map(r => ({ id: r.metadata.id, factText: r.content ?? '' }))
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
