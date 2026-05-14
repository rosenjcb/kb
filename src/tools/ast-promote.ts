/**
 * Promotes kg_* AST data into the facts table (import_code, source_ref=ast:…)
 * for direct fact retrieval and search.
 *
 * All promoted rows carry ids/source_refs prefixed with "ast:" so they can be
 * cleanly replaced on incremental re-index (kb scan).
 */

import type Database from 'better-sqlite3'
import type { SqliteKbIndexer } from './sqlite-kb-index.js'

export interface AstFactsPromoteStats {
  inserted: number
  updated: number
  tombstoned: number
}

/**
 * Promotes kg_nodes (exported symbols) and kg_edges (IMPLEMENTS, EXTENDS, IMPORTS_FILE)
 * into the facts table as `import_code` facts so they are queryable via `kb facts search`
 * and surfaced by the retrieval loop.
 *
 * Tombstones any existing `ast:`-prefixed facts whose source_ref is no longer present in
 * the current kg_* snapshot — safe to call on every ast-facts cycle.
 */
export function promoteAstToFactsTable(
  db: Database.Database,
  indexer: SqliteKbIndexer
): AstFactsPromoteStats {
  const stats: AstFactsPromoteStats = { inserted: 0, updated: 0, tombstoned: 0 }
  const newSourceRefs = new Set<string>()

  // 1. Exported symbol facts: "{Name} is a {subkind} exported from {path}"
  const symbols = db
    .prepare(
      "SELECT name, subkind, path FROM kg_nodes WHERE kind='symbol' AND exported=1 AND path IS NOT NULL"
    )
    .all() as Array<{ name: string; subkind: string | null; path: string }>

  for (const sym of symbols) {
    const sourceRef = `ast:${sym.path}@${sym.name}`
    const subkind = (sym.subkind ?? 'symbol').replace(/Declaration$/, '')
    const factText = `${sym.name} is a ${subkind} exported from ${sym.path}`
    newSourceRefs.add(sourceRef)
    const r = indexer.upsertFact({
      factText,
      sourceKind: 'import_code',
      sourceRef,
      confidence: 0.65,
      triplet: { subject: sym.name, predicate: 'exported_from', object: sym.path },
    })
    if (r.operation === 'inserted') stats.inserted++
    else stats.updated++
  }

  // 2. Structural relationship facts: IMPLEMENTS and EXTENDS edges
  const structuralEdges = db
    .prepare(
      `SELECT e.id, e.type, n1.name AS from_name, n1.path AS from_path, n2.name AS to_name
       FROM kg_edges e
       JOIN kg_nodes n1 ON e.from_id = n1.id
       JOIN kg_nodes n2 ON e.to_id = n2.id
       WHERE e.type IN ('IMPLEMENTS','EXTENDS')`
    )
    .all() as Array<{
      id: string
      type: string
      from_name: string
      from_path: string | null
      to_name: string
    }>

  for (const edge of structuralEdges) {
    const sourceRef = `ast:edge:${edge.id}`
    const predicate = edge.type.toLowerCase()
    const factText = edge.from_path
      ? `${edge.from_name} ${predicate} ${edge.to_name} in ${edge.from_path}`
      : `${edge.from_name} ${predicate} ${edge.to_name}`
    newSourceRefs.add(sourceRef)
    const r = indexer.upsertFact({
      factText,
      sourceKind: 'import_code',
      sourceRef,
      confidence: 0.7,
      triplet: { subject: edge.from_name, predicate, object: edge.to_name },
    })
    if (r.operation === 'inserted') stats.inserted++
    else stats.updated++
  }

  // 4. Tombstone stale ast: facts (source_ref no longer in current kg_* snapshot)
  // Note: IMPORTS_FILE edges are intentionally excluded — they're captured in kg_graph_relationships
  // for graph traversal and add retrieval noise (491 path-match facts drown out semantic results).
  const existing = indexer.listActiveFactsBySourceRefPrefix('ast:')
  for (const fact of existing) {
    if (fact.source_ref && !newSourceRefs.has(fact.source_ref)) {
      indexer.tombstoneFactById(fact.id)
      stats.tombstoned++
    }
  }

  return stats
}
