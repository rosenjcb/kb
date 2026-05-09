/**
 * Promotes exported symbols and file-import edges from kg_* tables into
 * kb_graph_entities / kb_graph_relationships so that query expansion and
 * graph traversal work for code-structure questions without a bridge table.
 *
 * All promoted relationships carry ids prefixed with "ast:" so they can be
 * cleanly replaced on incremental re-index (kb scan).
 */

import path from 'node:path'
import type Database from 'better-sqlite3'

export interface AstPromoteStats {
  entities: number
  relationships: number
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

/**
 * Clears then re-populates the AST-promoted portion of the semantic graph.
 * Safe to call on every ast-facts cycle (init or scan).
 */
export function promoteAstToSemanticGraph(db: Database.Database): AstPromoteStats {
  // Clear all previously-promoted relationships so stale edges don't linger.
  db.prepare("DELETE FROM kb_graph_relationships WHERE id LIKE 'ast:%'").run()

  let entities = 0
  let relationships = 0

  const entityInsert = db.prepare(`
    INSERT OR IGNORE INTO kb_graph_entities (id, name, type, description, created_at)
    VALUES (?, ?, 'system', ?, datetime('now'))
  `)

  // Promoted relationships use weight=0.9 so LLM-extracted (weight=1.0) always rank first.
  const relInsert = db.prepare(`
    INSERT OR IGNORE INTO kb_graph_relationships (id, from_id, to_id, type, weight, created_at)
    VALUES (?, ?, ?, ?, 0.9, datetime('now'))
  `)

  // 1. Promote exported symbol nodes → entities (id = slugify(name))
  const symbols = db
    .prepare(
      "SELECT id AS node_id, name, subkind, path FROM kg_nodes WHERE kind = 'symbol' AND exported = 1"
    )
    .all() as Array<{ node_id: string; name: string; subkind: string | null; path: string | null }>

  const symbolIdMap = new Map<string, string>() // kg node_id → semantic entity_id

  db.transaction(() => {
    for (const sym of symbols) {
      const entityId = slugify(sym.name)
      const desc = [sym.subkind, sym.path].filter(Boolean).join(' in ') || null
      const r = entityInsert.run(entityId, sym.name, desc)
      if (r.changes > 0) entities++
      symbolIdMap.set(sym.node_id, entityId)
    }
  })()

  // 2. Promote file nodes → entities (id = slugify(basename without extension))
  const files = db
    .prepare("SELECT id AS node_id, name, path FROM kg_nodes WHERE kind = 'file'")
    .all() as Array<{ node_id: string; name: string; path: string | null }>

  const fileIdMap = new Map<string, string>() // kg node_id → semantic entity_id

  db.transaction(() => {
    for (const file of files) {
      const relPath = file.path ?? file.name
      const basename = path.basename(relPath, path.extname(relPath))
      const entityId = slugify(basename)
      const r = entityInsert.run(entityId, relPath, 'source file')
      if (r.changes > 0) entities++
      fileIdMap.set(file.node_id, entityId)
    }
  })()

  // 3. Promote direct structural edges
  const edgeTypeMap: Record<string, string> = {
    IMPORTS_FILE: 'imports',
    EXPORTS_SYMBOL: 'exports',
    IMPLEMENTS: 'implements',
    EXTENDS: 'extends',
  }

  const directEdges = db
    .prepare(
      "SELECT id, type, from_id, to_id FROM kg_edges WHERE type IN ('IMPORTS_FILE','EXPORTS_SYMBOL','IMPLEMENTS','EXTENDS')"
    )
    .all() as Array<{ id: string; type: string; from_id: string; to_id: string }>

  db.transaction(() => {
    for (const edge of directEdges) {
      const fromId = fileIdMap.get(edge.from_id) ?? symbolIdMap.get(edge.from_id)
      const toId = fileIdMap.get(edge.to_id) ?? symbolIdMap.get(edge.to_id)
      if (!fromId || !toId) continue
      const relType = edgeTypeMap[edge.type] ?? 'related_to'
      const r = relInsert.run(`ast:${edge.id}`, fromId, toId, relType)
      if (r.changes > 0) relationships++
    }
  })()

  return { entities, relationships }
}
