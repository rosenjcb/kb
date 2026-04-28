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
