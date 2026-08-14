/**
 * Read-side API for the AST symbol index (`code_symbols` + `doc_code_links`).
 * All queries are synchronous (node:sqlite).
 *
 * V1 exposes exported symbols and their documenting markdown files. Code-to-code
 * structural neighbors (imports/extends) are not first-class until a later optional
 * code-intelligence index is reintroduced — `getNeighbors` returns the documenting
 * docs for a symbol instead.
 */

import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../core/db-migrations'

export interface CodeSymbol {
  id: string
  name: string
  path: string | null
  subkind: string | null
  evidence: string
}

export interface CodeSymbolNeighbor {
  /** Always `documented_by` in v1 — the hop is a doc↔symbol join, not a graph edge. */
  predicate: string
  evidence: string
  symbol: CodeSymbol
}

export interface CodeGraphSummary {
  facts: number
  edges: number
  files: number
  symbols: number
  lastIndexed: string | null
}

function rowToSymbol(r: {
  id: string
  name: string
  rel_path?: string | null
  kind?: string | null
}): CodeSymbol {
  return {
    id: r.id,
    name: r.name,
    path: r.rel_path ?? null,
    subkind: r.kind ?? null,
    evidence: 'definitional',
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
    const symbols = (
      this.db.prepare('SELECT COUNT(*) AS n FROM code_symbols').get() as { n: number }
    ).n
    const files = (
      this.db.prepare('SELECT COUNT(DISTINCT rel_path) AS n FROM code_symbols').get() as {
        n: number
      }
    ).n
    const links = (
      this.db.prepare('SELECT COUNT(*) AS n FROM doc_code_links').get() as { n: number }
    ).n
    const documents = (
      this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
    ).n
    const lastRow = this.db
      .prepare('SELECT indexed_at FROM code_file_state ORDER BY indexed_at DESC LIMIT 1')
      .get() as { indexed_at: string } | undefined

    return {
      // `facts` here means "indexed units agents care about" (docs + symbols) for tool
      // summaries that still name the field that way.
      facts: Number(documents) + Number(symbols),
      edges: Number(links),
      files: Number(files),
      symbols: Number(symbols),
      lastIndexed: lastRow?.indexed_at ?? null,
    }
  }

  searchSymbols(query: string, opts: { limit?: number } = {}): CodeSymbol[] {
    const limit = opts.limit ?? 20
    const trimmed = query.trim()
    if (!trimmed) return []
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.name, s.rel_path, s.kind
           FROM code_symbols_fts fts
           JOIN code_symbols s ON s.id = fts.symbol_id
           WHERE code_symbols_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(trimmed, limit) as Array<{
        id: string
        name: string
        rel_path: string
        kind: string
      }>
      return rows.map(rowToSymbol)
    } catch {
      const like = `%${trimmed.toLowerCase()}%`
      const rows = this.db
        .prepare(
          `SELECT id, name, rel_path, kind FROM code_symbols
           WHERE lower(name) LIKE ? OR lower(rel_path) LIKE ?
           ORDER BY name LIMIT ?`
        )
        .all(like, like, limit) as Array<{
        id: string
        name: string
        rel_path: string
        kind: string
      }>
      return rows.map(rowToSymbol)
    }
  }

  /**
   * Units related to a symbol via the flat `doc_code_links` join (documenting files).
   * Returned as "neighbors" with predicate `documented_by` for agent-tool compatibility.
   */
  getNeighbors(symbolId: string, opts: { limit?: number } = {}): CodeSymbolNeighbor[] {
    const limit = opts.limit ?? 50
    const rows = this.db
      .prepare(
        `SELECT d.id, d.title AS name, d.rel_path, d.git_repo
         FROM doc_code_links l
         JOIN documents d ON d.id = l.doc_id
         WHERE l.symbol_id = ?
         ORDER BY l.score DESC
         LIMIT ?`
      )
      .all(symbolId, limit) as Array<{
      id: string
      name: string
      rel_path: string
      git_repo: string
    }>
    return rows.map(r => ({
      predicate: 'documented_by',
      evidence: 'contextual',
      symbol: {
        id: r.id,
        name: r.name,
        path: r.git_repo ? `${r.git_repo}/${r.rel_path}` : r.rel_path,
        subkind: 'document',
        evidence: 'contextual',
      },
    }))
  }

  /** Find exported code symbols whose name matches any of the given terms via FTS. */
  findCodeSymbolsByName(terms: string[], limit = 10): CodeSymbol[] {
    if (terms.length === 0) return []
    const query = terms.join(' OR ')
    return this.searchSymbols(query, { limit })
  }
}
