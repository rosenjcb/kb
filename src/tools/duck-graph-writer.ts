/**
 * DuckGraphWriter — knowledge graph storage using DuckDB + DuckPGQ.
 *
 * Schema:
 *   entities      — nodes (concepts, systems, tools, decisions)
 *   relationships — directed edges between entities
 *
 * The property graph (kb_graph) is created once and queried with SQL/PGQ.
 * Soft-delete on invalidate: weight set to 0, not removed.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import path from 'node:path'

export type EntityType = 'concept' | 'system' | 'tool' | 'decision' | 'person'
export type RelationshipType = 'depends_on' | 'contradicts' | 'related_to' | 'replaces' | 'implements' | 'uses'

export interface GraphEntity {
  id: string
  name: string
  type: EntityType
  docId?: string
}

export interface GraphRelationship {
  fromId: string
  toId: string
  type: RelationshipType
  docId?: string
  weight?: number
}

export interface GraphNeighbors {
  entity: GraphEntity
  outgoing: Array<{ rel: RelationshipType; target: GraphEntity }>
  incoming: Array<{ rel: RelationshipType; source: GraphEntity }>
}

export interface GraphPath {
  nodes: string[]
  hops: number
}

export interface GraphSummary {
  totalEntities: number
  totalRelationships: number
  topEntities: Array<{ id: string; name: string; type: string; connections: number }>
}

export class DuckGraphWriter {
  private instance: DuckDBInstance | null = null
  private conn: DuckDBConnection | null = null
  private ready = false

  constructor(private readonly dbPath: string) {}

  async open(): Promise<void> {
    if (this.ready) return
    this.instance = await DuckDBInstance.create(this.dbPath)
    this.conn = await this.instance.connect()
    await this.setupExtension()
    await this.setupSchema()
    this.ready = true
  }

  private async setupExtension(): Promise<void> {
    try {
      await this.conn!.run('INSTALL duckpgq FROM community')
      await this.conn!.run('LOAD duckpgq')
    } catch {
      // Extension not available — graph queries fall back to recursive CTEs
    }
  }

  private async setupSchema(): Promise<void> {
    const c = this.conn!
    await c.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL DEFAULT 'concept',
        doc_id     TEXT DEFAULT NULL,
        created_at TEXT NOT NULL
      )
    `)
    await c.run(`
      CREATE TABLE IF NOT EXISTS relationships (
        id         TEXT PRIMARY KEY,
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        type       TEXT NOT NULL,
        doc_id     TEXT DEFAULT NULL,
        weight     DOUBLE NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL
      )
    `)
    // Try to create property graph — only works if duckpgq loaded
    try {
      await c.run(`
        CREATE OR REPLACE PROPERTY GRAPH kb_graph
          VERTEX TABLES (entities)
          EDGE TABLES (
            relationships
              SOURCE KEY (from_id) REFERENCES entities (id)
              DESTINATION KEY (to_id) REFERENCES entities (id)
          )
      `)
    } catch {
      // Silently skip — recursive CTEs handle all traversal without it
    }
  }

  async upsertEntities(entities: GraphEntity[]): Promise<void> {
    if (!this.ready) await this.open()
    const now = new Date().toISOString()
    for (const e of entities) {
      const id = slugify(e.id || e.name)
      if (e.docId) {
        await this.conn!.run(`
          INSERT INTO entities (id, name, type, doc_id, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            doc_id = EXCLUDED.doc_id
        `, [id, e.name, e.type, e.docId, now])
      } else {
        await this.conn!.run(`
          INSERT INTO entities (id, name, type, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type
        `, [id, e.name, e.type, now])
      }
    }
  }

  async upsertRelationships(relationships: GraphRelationship[]): Promise<void> {
    if (!this.ready) await this.open()
    const now = new Date().toISOString()
    for (const r of relationships) {
      const fromId = slugify(r.fromId)
      const toId = slugify(r.toId)
      const id = `${fromId}__${r.type}__${toId}`
      // Ensure both endpoints exist as stub entities before inserting edge
      // Stub endpoints — only insert, never update (ON CONFLICT DO NOTHING)
      await this.conn!.run(`
        INSERT INTO entities (id, name, type, created_at)
        VALUES (?, ?, 'concept', ?)
        ON CONFLICT (id) DO NOTHING
      `, [fromId, fromId, now])
      await this.conn!.run(`
        INSERT INTO entities (id, name, type, created_at)
        VALUES (?, ?, 'concept', ?)
        ON CONFLICT (id) DO NOTHING
      `, [toId, toId, now])
      // Edge upsert — avoid null parameters
      if (r.docId) {
        await this.conn!.run(`
          INSERT INTO relationships (id, from_id, to_id, type, doc_id, weight, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            weight = GREATEST(relationships.weight, EXCLUDED.weight),
            doc_id = EXCLUDED.doc_id
        `, [id, fromId, toId, r.type, r.docId, r.weight ?? 1.0, now])
      } else {
        await this.conn!.run(`
          INSERT INTO relationships (id, from_id, to_id, type, weight, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            weight = GREATEST(relationships.weight, EXCLUDED.weight)
        `, [id, fromId, toId, r.type, r.weight ?? 1.0, now])
      }
    }
  }

  /** Soft-delete all edges originating from a document (e.g. on kb invalidate). */
  async softDeleteByDocId(docId: string): Promise<number> {
    if (!this.ready) await this.open()
    await this.conn!.run(
      `UPDATE relationships SET weight = 0 WHERE doc_id = ?`,
      [docId],
    )
    const result = await this.conn!.runAndReadAll(
      `SELECT COUNT(*) AS n FROM relationships WHERE doc_id = ? AND weight = 0`,
      [docId],
    )
    const rows = result.getRows()
    return Number(rows[0]?.[0] ?? 0)
  }

  async getSummary(): Promise<GraphSummary> {
    if (!this.ready) await this.open()
    const c = this.conn!

    const totalE = await c.runAndReadAll(
      `SELECT COUNT(*) FROM entities`,
    )
    const totalR = await c.runAndReadAll(
      `SELECT COUNT(*) FROM relationships WHERE weight > 0`,
    )

    const top = await c.runAndReadAll(`
      SELECT e.id, e.name, e.type, COUNT(*) AS connections
      FROM entities e
      JOIN (
        SELECT from_id AS entity_id FROM relationships WHERE weight > 0
        UNION ALL
        SELECT to_id   AS entity_id FROM relationships WHERE weight > 0
      ) r ON e.id = r.entity_id
      GROUP BY e.id, e.name, e.type
      ORDER BY connections DESC
      LIMIT 20
    `)

    return {
      totalEntities: Number(totalE.getRows()[0]?.[0] ?? 0),
      totalRelationships: Number(totalR.getRows()[0]?.[0] ?? 0),
      topEntities: top.getRows().map(row => ({
        id: String(row[0]),
        name: String(row[1]),
        type: String(row[2]),
        connections: Number(row[3]),
      })),
    }
  }

  async getNeighbors(entityId: string): Promise<GraphNeighbors | null> {
    if (!this.ready) await this.open()
    const c = this.conn!
    const id = slugify(entityId)

    const entityRows = await c.runAndReadAll(
      `SELECT id, name, type, doc_id FROM entities WHERE id = ?`, [id],
    )
    const eRow = entityRows.getRows()[0]
    if (!eRow) return null

    const entity: GraphEntity = {
      id: String(eRow[0]),
      name: String(eRow[1]),
      type: eRow[2] as EntityType,
      docId: eRow[3] ? String(eRow[3]) : undefined,
    }

    const outRows = await c.runAndReadAll(`
      SELECT r.type, e.id, e.name, e.type
      FROM relationships r
      JOIN entities e ON r.to_id = e.id
      WHERE r.from_id = ? AND r.weight > 0
    `, [id])

    const inRows = await c.runAndReadAll(`
      SELECT r.type, e.id, e.name, e.type
      FROM relationships r
      JOIN entities e ON r.from_id = e.id
      WHERE r.to_id = ? AND r.weight > 0
    `, [id])

    return {
      entity,
      outgoing: outRows.getRows().map(r => ({
        rel: String(r[0]) as RelationshipType,
        target: { id: String(r[1]), name: String(r[2]), type: r[3] as EntityType },
      })),
      incoming: inRows.getRows().map(r => ({
        rel: String(r[0]) as RelationshipType,
        source: { id: String(r[1]), name: String(r[2]), type: r[3] as EntityType },
      })),
    }
  }

  async findPath(fromId: string, toId: string, maxDepth = 6): Promise<GraphPath | null> {
    if (!this.ready) await this.open()
    const from = slugify(fromId)
    const to = slugify(toId)

    const result = await this.conn!.runAndReadAll(`
      WITH RECURSIVE reach(node, path, depth) AS (
        SELECT ?, [?], 0
        UNION ALL
        SELECT r.to_id, list_append(rc.path, r.to_id), rc.depth + 1
        FROM relationships r
        JOIN reach rc ON r.from_id = rc.node
        WHERE rc.depth < ?
          AND r.weight > 0
          AND NOT list_contains(rc.path, r.to_id)
      )
      SELECT path, depth FROM reach WHERE node = ? LIMIT 1
    `, [from, from, maxDepth, to])

    const rows = result.getRows()
    if (rows.length === 0) return null

    const row = rows[0]
    const pathValue = row[0] as { items?: unknown[] }
    const nodes = (pathValue?.items ?? []).map(item => String(item ?? ''))
    return { nodes, hops: Number(row[1]) }
  }

  /**
   * Given a set of entity slugs (query terms), return the names of their direct
   * neighbors. Used for graph-augmented query expansion before retrieval.
   */
  async expandQuery(slugs: string[]): Promise<string[]> {
    if (!this.ready) await this.open()
    if (slugs.length === 0) return []

    const placeholders = slugs.map(() => '?').join(', ')
    const rows = await this.conn!.runAndReadAll(`
      SELECT DISTINCT e.name
      FROM relationships r
      JOIN entities e ON (
        (r.from_id IN (${placeholders}) AND r.to_id = e.id)
        OR
        (r.to_id IN (${placeholders}) AND r.from_id = e.id)
      )
      WHERE r.weight > 0
    `, [...slugs, ...slugs])

    const neighborNames = rows.getRows().map(row => String(row[0]))
    return neighborNames.filter(name => !slugs.includes(slugify(name)))
  }

  async exportDot(): Promise<string> {
    if (!this.ready) await this.open()
    const result = await this.conn!.runAndReadAll(`
      SELECT e1.name, r.type, e2.name
      FROM relationships r
      JOIN entities e1 ON r.from_id = e1.id
      JOIN entities e2 ON r.to_id = e2.id
      WHERE r.weight > 0
    `)
    const lines = ['digraph kb_graph {', '  rankdir=LR;']
    for (const row of result.getRows()) {
      const from = String(row[0]).replace(/"/g, '\\"')
      const rel = String(row[1])
      const to = String(row[2]).replace(/"/g, '\\"')
      lines.push(`  "${from}" -> "${to}" [label="${rel}"];`)
    }
    lines.push('}')
    return lines.join('\n')
  }

  async exportJson(): Promise<{ entities: GraphEntity[]; relationships: GraphRelationship[] }> {
    if (!this.ready) await this.open()
    const c = this.conn!

    const eRows = await c.runAndReadAll(`SELECT id, name, type, doc_id FROM entities`)
    const rRows = await c.runAndReadAll(
      `SELECT from_id, to_id, type, doc_id, weight FROM relationships WHERE weight > 0`,
    )

    return {
      entities: eRows.getRows().map(r => ({
        id: String(r[0]),
        name: String(r[1]),
        type: r[2] as EntityType,
        docId: r[3] ? String(r[3]) : undefined,
      })),
      relationships: rRows.getRows().map(r => ({
        fromId: String(r[0]),
        toId: String(r[1]),
        type: r[2] as RelationshipType,
        docId: r[3] ? String(r[3]) : undefined,
        weight: Number(r[4]),
      })),
    }
  }

  close(): void {
    this.conn?.disconnect()
    this.conn = null
    this.instance = null
    this.ready = false
  }

  static dbPathForBase(baseDir: string): string {
    return path.join(baseDir, '.kb-graph.duckdb')
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}
