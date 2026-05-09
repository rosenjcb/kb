/**
 * Read-side API for the code graph (kg_* tables).
 * All queries are synchronous (better-sqlite3).
 */

import Database from 'better-sqlite3'
import { runMigrations } from '../core/db-migrations'

export interface KgNode {
  id: string
  kind: string
  subkind: string | null
  name: string
  qualifiedName: string | null
  path: string | null
  fileId: string | null
  language: string | null
  spanStart: number | null
  spanEnd: number | null
  exported: boolean
  source: string
  confidence: number
}

export interface KgEdgeWithNode {
  edgeType: string
  confidence: number
  node: KgNode
}

export interface CodeGraphSummary {
  nodes: number
  edges: number
  files: number
  symbols: number
  lastIndexed: string | null
}

function rowToNode(r: Record<string, unknown>): KgNode {
  return {
    id: r.id as string,
    kind: r.kind as string,
    subkind: (r.subkind as string | null) ?? null,
    name: r.name as string,
    qualifiedName: (r.qualified_name as string | null) ?? null,
    path: (r.path as string | null) ?? null,
    fileId: (r.file_id as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    spanStart: (r.span_start as number | null) ?? null,
    spanEnd: (r.span_end as number | null) ?? null,
    exported: r.exported === 1,
    source: r.source as string,
    confidence: r.confidence as number,
  }
}

export class CodeGraphStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: false })
    this.db.pragma('journal_mode = WAL')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  getSummary(): CodeGraphSummary {
    const nodes = (this.db.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get() as { n: number }).n
    const edges = (this.db.prepare('SELECT COUNT(*) AS n FROM kg_edges').get() as { n: number }).n
    const files = (
      this.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE kind = 'file'").get() as {
        n: number
      }
    ).n
    const symbols = (
      this.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE kind = 'symbol'").get() as {
        n: number
      }
    ).n
    const lastRow = this.db
      .prepare('SELECT indexed_at FROM kg_file_state ORDER BY indexed_at DESC LIMIT 1')
      .get() as { indexed_at: string } | undefined

    return {
      nodes: Number(nodes),
      edges: Number(edges),
      files: Number(files),
      symbols: Number(symbols),
      lastIndexed: lastRow?.indexed_at ?? null,
    }
  }

  searchSymbols(query: string, opts: { limit?: number; kind?: string } = {}): KgNode[] {
    const limit = opts.limit ?? 20
    const rows = this.db
      .prepare(
        `
        SELECT n.*
        FROM kg_nodes_fts f
        JOIN kg_nodes n ON n.id = f.id
        WHERE kg_nodes_fts MATCH ?
          AND n.kind = 'symbol'
          ${opts.kind ? `AND n.subkind = '${opts.kind}'` : ''}
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(query, limit) as Record<string, unknown>[]
    return rows.map(rowToNode)
  }

  getNode(id: string): KgNode | null {
    const row = this.db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToNode(row) : null
  }

  getNeighbors(
    id: string,
    opts: { edgeTypes?: string[]; direction?: 'out' | 'in' | 'both'; limit?: number } = {}
  ): KgEdgeWithNode[] {
    const direction = opts.direction ?? 'both'
    const limit = opts.limit ?? 50

    const typeFilter =
      opts.edgeTypes && opts.edgeTypes.length > 0
        ? `AND e.type IN (${opts.edgeTypes.map(() => '?').join(', ')})`
        : ''
    const typeParams = opts.edgeTypes ?? []

    const rows: KgEdgeWithNode[] = []

    if (direction === 'out' || direction === 'both') {
      const outRows = this.db
        .prepare(
          `
          SELECT e.type AS edge_type, e.confidence AS edge_confidence, n.*
          FROM kg_edges e
          JOIN kg_nodes n ON n.id = e.to_id
          WHERE e.from_id = ? ${typeFilter}
          ORDER BY e.confidence DESC
          LIMIT ?
        `
        )
        .all(id, ...typeParams, limit) as Record<string, unknown>[]
      for (const r of outRows) {
        rows.push({
          edgeType: r.edge_type as string,
          confidence: r.edge_confidence as number,
          node: rowToNode(r),
        })
      }
    }

    if (direction === 'in' || direction === 'both') {
      const inRows = this.db
        .prepare(
          `
          SELECT e.type AS edge_type, e.confidence AS edge_confidence, n.*
          FROM kg_edges e
          JOIN kg_nodes n ON n.id = e.from_id
          WHERE e.to_id = ? ${typeFilter}
          ORDER BY e.confidence DESC
          LIMIT ?
        `
        )
        .all(id, ...typeParams, limit) as Record<string, unknown>[]
      for (const r of inRows) {
        rows.push({
          edgeType: r.edge_type as string,
          confidence: r.edge_confidence as number,
          node: rowToNode(r),
        })
      }
    }

    return rows
  }

  findCallers(symbolId: string, opts: { limit?: number } = {}): KgNode[] {
    const limit = opts.limit ?? 20
    const rows = this.db
      .prepare(
        `
        SELECT n.*
        FROM kg_edges e
        JOIN kg_nodes n ON n.id = e.from_id
        WHERE e.to_id = ? AND e.type = 'EXPORTS_SYMBOL'
        ORDER BY e.confidence DESC
        LIMIT ?
      `
      )
      .all(symbolId, limit) as Record<string, unknown>[]
    return rows.map(rowToNode)
  }

  getFileSymbols(fileId: string): KgNode[] {
    const rows = this.db
      .prepare("SELECT * FROM kg_nodes WHERE file_id = ? AND kind = 'symbol' ORDER BY span_start")
      .all(fileId) as Record<string, unknown>[]
    return rows.map(rowToNode)
  }

  /**
   * Find exported code symbols whose name or qualified name matches any of the
   * given terms. Used for query expansion without a bridge table — direct FTS.
   */
  findCodeSymbolsByName(terms: string[], limit = 10): KgNode[] {
    if (terms.length === 0) return []
    const query = terms.join(' OR ')
    const rows = this.db
      .prepare(
        `
        SELECT n.*
        FROM kg_nodes_fts fts
        JOIN kg_nodes n ON n.id = fts.id
        WHERE kg_nodes_fts MATCH ? AND n.kind = 'symbol' AND n.exported = 1
        ORDER BY rank
        LIMIT ?
        `
      )
      .all(query, limit) as Record<string, unknown>[]
    return rows.map(rowToNode)
  }
}
