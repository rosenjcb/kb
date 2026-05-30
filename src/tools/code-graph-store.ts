/**
 * Read-side API for code facts (source_kind='import_code' rows in the facts table).
 * All queries are synchronous (node:sqlite).
 */

import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../core/db-migrations'

export interface CodeSymbol {
  id: string
  name: string
  path: string | null
  subkind: string | null
  confidence: number
}

export interface CodeSymbolNeighbor {
  predicate: string
  confidence: number
  symbol: CodeSymbol
}

export interface CodeGraphSummary {
  facts: number
  edges: number
  files: number
  symbols: number
  lastIndexed: string | null
}

function rowToSymbol(r: Record<string, unknown>): CodeSymbol {
  return {
    id: r.id as string,
    name: r.subject as string,
    path: (r.object as string | null) ?? null,
    subkind: null,
    confidence: r.confidence as number,
  }
}

export class CodeGraphStore {
  private db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  getSummary(): CodeGraphSummary {
    const facts = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM facts WHERE source_kind = 'import_code' AND tombstoned_at IS NULL"
        )
        .get() as { n: number }
    ).n
    const edges = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM fact_edges fe
           JOIN facts f ON f.id = fe.from_fact_id
           WHERE f.source_kind = 'import_code' AND f.tombstoned_at IS NULL`
        )
        .get() as { n: number }
    ).n
    const files = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM facts WHERE source_kind = 'import_code' AND predicate = 'imports' AND tombstoned_at IS NULL"
        )
        .get() as { n: number }
    ).n
    const symbols = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM facts WHERE source_kind = 'import_code' AND predicate = 'exported_from' AND tombstoned_at IS NULL"
        )
        .get() as { n: number }
    ).n
    const lastRow = this.db
      .prepare(
        "SELECT indexed_at FROM code_file_state ORDER BY indexed_at DESC LIMIT 1"
      )
      .get() as { indexed_at: string } | undefined

    return {
      facts: Number(facts),
      edges: Number(edges),
      files: Number(files),
      symbols: Number(symbols),
      lastIndexed: lastRow?.indexed_at ?? null,
    }
  }

  searchSymbols(query: string, opts: { limit?: number } = {}): CodeSymbol[] {
    const limit = opts.limit ?? 20
    const rows = this.db
      .prepare(
        `SELECT f.id, f.subject, f.object, f.confidence
         FROM facts_fts fts
         JOIN facts f ON f.id = fts.fact_id
         WHERE facts_fts MATCH ?
           AND f.source_kind = 'import_code'
           AND f.predicate = 'exported_from'
           AND f.tombstoned_at IS NULL
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as Record<string, unknown>[]
    return rows.map(rowToSymbol)
  }

  getNeighbors(factId: string, opts: { limit?: number } = {}): CodeSymbolNeighbor[] {
    const limit = opts.limit ?? 50
    const rows = this.db
      .prepare(
        `SELECT f2.id, f2.subject, f2.object, f2.predicate, f2.confidence
         FROM fact_edges fe
         JOIN facts f2 ON f2.id = fe.to_fact_id
         WHERE fe.from_fact_id = ?
           AND f2.source_kind = 'import_code'
           AND f2.tombstoned_at IS NULL
         LIMIT ?`
      )
      .all(factId, limit) as Record<string, unknown>[]
    return rows.map(r => ({
      predicate: r.predicate as string,
      confidence: r.confidence as number,
      symbol: rowToSymbol(r),
    }))
  }

  /**
   * Find exported code symbols whose name matches any of the given terms via FTS.
   */
  findCodeSymbolsByName(terms: string[], limit = 10): CodeSymbol[] {
    if (terms.length === 0) return []
    const query = terms.join(' OR ')
    const rows = this.db
      .prepare(
        `SELECT f.id, f.subject, f.object, f.confidence
         FROM facts_fts fts
         JOIN facts f ON f.id = fts.fact_id
         WHERE facts_fts MATCH ?
           AND f.source_kind = 'import_code'
           AND f.predicate = 'exported_from'
           AND f.tombstoned_at IS NULL
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as Record<string, unknown>[]
    return rows.map(rowToSymbol)
  }
}
