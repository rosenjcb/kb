import type { SqliteKbIndexer } from '../tools/sqlite-kb-index'

export interface SupportingFact {
  id: string
  factText: string
}

/**
 * Search the facts store for entries supporting a doc-generate prompt.
 *
 * Wraps `indexer.searchFacts` (the lexical/FTS path that powered the legacy
 * `generate_document_from_facts` tool) and projects rows to a shape
 * suitable for the References footer renderer.
 */
export function searchSupportingFacts(
  indexer: Pick<SqliteKbIndexer, 'searchFacts'>,
  query: string,
  limit = 20
): SupportingFact[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const rows = indexer.searchFacts(trimmed, limit)
  return rows.map(row => ({ id: row.id, factText: row.fact_text }))
}

/** Markdown block listing grounded facts for doc-generate LLM prompts. */
export function buildDocgenFactContext(facts: SupportingFact[]): string {
  if (facts.length === 0) {
    return 'KB facts (grounding):\n(none — do not invent repository facts.)'
  }
  const lines = facts.map(
    (f, i) => `${i + 1}. [${f.id}] ${f.factText.replace(/\r?\n/g, ' ').trim()}`
  )
  return ['KB facts (ground repository claims only with these; do not invent other facts):', ...lines].join(
    '\n'
  )
}
