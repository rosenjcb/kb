/**
 * DuckGraphWriter — knowledge graph storage using DuckDB.
 *
 * Schema:
 *   entities      — nodes (concepts, systems, tools, decisions)
 *   relationships — directed edges between entities
 *
 * Traversal/query helpers use table queries and recursive CTEs only.
 * Soft-delete on invalidate: weight set to 0, not removed.
 */

import path from 'node:path'
import { mkdir, rmdir } from 'node:fs/promises'
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

export type EntityType = 'concept' | 'system' | 'tool' | 'decision' | 'person'
export type RelationshipType =
  | 'depends_on'
  | 'contradicts'
  | 'related_to'
  | 'replaces'
  | 'implements'
  | 'uses'

export interface GraphEntity {
  id: string
  name: string
  type: EntityType
  docId?: string
  /** Optional human-readable notes; manual `kb graph node` edits and future extractors may set this. */
  description?: string | null
}

/** Stored on edges; may be any slug-safe label (well-known set below + custom verbs from `kb graph edge`). */
export interface GraphRelationship {
  fromId: string
  toId: string
  type: string
  docId?: string
  weight?: number
}

export interface GraphNeighbors {
  entity: GraphEntity
  outgoing: Array<{ rel: string; target: GraphEntity }>
  incoming: Array<{ rel: string; source: GraphEntity }>
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

export interface GraphDocumentAffinity {
  boost: number
  evidence: string[]
}

export class DuckGraphWriter {
  private static readonly writeQueueByPath = new Map<string, Promise<void>>()

  private conn: DuckDBConnection | null = null
  private ready = false
  private transactionLockRelease: (() => Promise<void>) | null = null

  constructor(private readonly dbPath: string) {}

  async open(): Promise<void> {
    if (this.ready) return
    if (!this.transactionLockRelease) {
      await this.withWriteLease(async () => {
        if (!this.ready) await this.openUnlocked()
      })
      return
    }
    await this.openUnlocked()
  }

  private async openUnlocked(): Promise<void> {
    if (this.ready) return
    const instance = await DuckDBInstance.create(this.dbPath)
    const conn = await instance.connect()
    try {
      this.conn = conn
      await this.setupSchema()
      this.ready = true
    } catch (error) {
      try {
        conn.disconnect()
      } catch {
        // Best-effort cleanup after failed open.
      }
      this.conn = null
      this.ready = false
      throw error
    }
  }

  private requireConn(): DuckDBConnection {
    const c = this.conn
    if (!c) {
      throw new Error('DuckGraphWriter must be opened before use')
    }
    return c
  }

  private async setupSchema(): Promise<void> {
    const c = this.requireConn()
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
    try {
      await c.run('ALTER TABLE entities ADD COLUMN IF NOT EXISTS description VARCHAR')
    } catch {
      // Best-effort schema upgrade for older graph files
    }
  }

  async upsertEntities(entities: GraphEntity[]): Promise<void> {
    await this.runWrite(async () => {
      const now = new Date().toISOString()
      for (const e of entities) {
        const id = slugify(e.id || e.name)
        // DuckDB node-api rejects JS null binds — use empty string + NULLIF for optional columns.
        const docBinding = (e.docId?.trim() ?? '') || ''
        const descBinding =
          e.description === undefined || e.description === null ? '' : String(e.description)
        await this.conn?.run(
          `
          INSERT INTO entities (id, name, type, doc_id, description, created_at)
          VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            doc_id = COALESCE(NULLIF(EXCLUDED.doc_id, ''), entities.doc_id),
            description = COALESCE(EXCLUDED.description, entities.description)
        `,
          [id, e.name, e.type, docBinding, descBinding, now]
        )
      }
    })
  }

  async upsertRelationships(relationships: GraphRelationship[]): Promise<void> {
    await this.runWrite(async () => {
      const now = new Date().toISOString()
      for (const r of relationships) {
        const fromId = (await this.resolveEntityRef(r.fromId)) ?? slugify(r.fromId)
        const toId = (await this.resolveEntityRef(r.toId)) ?? slugify(r.toId)
        const relType = normalizeRelationshipTypeLabel(r.type)
        const id = `${fromId}__${relType}__${toId}`
        // Ensure both endpoints exist as stub entities before inserting edge
        // Stub endpoints — only insert, never update (ON CONFLICT DO NOTHING)
        await this.conn?.run(
          `
          INSERT INTO entities (id, name, type, created_at)
          VALUES (?, ?, 'concept', ?)
          ON CONFLICT (id) DO NOTHING
        `,
          [fromId, fromId, now]
        )
        await this.conn?.run(
          `
          INSERT INTO entities (id, name, type, created_at)
          VALUES (?, ?, 'concept', ?)
          ON CONFLICT (id) DO NOTHING
        `,
          [toId, toId, now]
        )
        // Edge upsert — avoid null parameters
        if (r.docId) {
          await this.conn?.run(
            `
            INSERT INTO relationships (id, from_id, to_id, type, doc_id, weight, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              weight = GREATEST(relationships.weight, EXCLUDED.weight),
              doc_id = EXCLUDED.doc_id
          `,
            [id, fromId, toId, relType, r.docId, r.weight ?? 1.0, now]
          )
        } else {
          await this.conn?.run(
            `
            INSERT INTO relationships (id, from_id, to_id, type, weight, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              weight = GREATEST(relationships.weight, EXCLUDED.weight)
          `,
            [id, fromId, toId, relType, r.weight ?? 1.0, now]
          )
        }
      }
    })
  }

  /** Soft-delete all edges originating from a document (e.g. on kb invalidate). */
  async softDeleteByDocId(docId: string): Promise<number> {
    return this.runWrite(async () => {
      const c = this.requireConn()
      await c.run('UPDATE relationships SET weight = 0 WHERE doc_id = ?', [docId])
      const result = await c.runAndReadAll(
        'SELECT COUNT(*) AS n FROM relationships WHERE doc_id = ? AND weight = 0',
        [docId]
      )
      const rows = result.getRows()
      return Number(rows[0]?.[0] ?? 0)
    })
  }

  /**
   * Resolve a human reference (entity id slug, or display name) to canonical entity id.
   */
  async resolveEntityRef(ref: string): Promise<string | null> {
    if (!this.ready) await this.open()
    const c = this.requireConn()
    const trimmed = ref.trim()
    if (!trimmed) return null

    const slug = slugify(trimmed)
    if (slug) {
      const byId = await c.runAndReadAll('SELECT id FROM entities WHERE id = ?', [slug])
      const idRow = byId.getRows()[0]
      if (idRow) return String(idRow[0])
    }

    const byName = await c.runAndReadAll(
      'SELECT id FROM entities WHERE lower(name) = lower(?) LIMIT 1',
      [trimmed]
    )
    const nameRow = byName.getRows()[0]
    return nameRow ? String(nameRow[0]) : null
  }

  /**
   * Patch fields on an entity resolved by id or display name. Returns false if the entity does not exist.
   */
  async updateEntityByRef(
    entityRef: string,
    patch: { name?: string; description?: string | null; type?: EntityType }
  ): Promise<boolean> {
    if (!this.ready) await this.open()
    const id = await this.resolveEntityRef(entityRef)
    if (!id) return false

    const sets: string[] = []
    const values: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.description !== undefined) {
      sets.push(`description = NULLIF(?, '')`)
      values.push(patch.description === null ? '' : String(patch.description))
    }
    if (patch.type !== undefined) {
      sets.push('type = ?')
      values.push(patch.type)
    }
    if (sets.length === 0) return true

    values.push(id)
    const c = this.requireConn()
    await c.run(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`, values as string[])
    return true
  }

  /** Soft-delete a single directed edge (same semantics as invalidate-driven doc-level deletes). */
  async softDeleteEdge(fromId: string, toId: string, relType: string): Promise<number> {
    return this.runWrite(async () => {
      const c = this.requireConn()
      const from = (await this.resolveEntityRef(fromId)) ?? slugify(fromId)
      const to = (await this.resolveEntityRef(toId)) ?? slugify(toId)
      const type = normalizeRelationshipTypeLabel(relType)
      const before = await c.runAndReadAll(
        'SELECT COUNT(*) FROM relationships WHERE from_id = ? AND to_id = ? AND type = ? AND weight > 0',
        [from, to, type]
      )
      const n = Number(before.getRows()[0]?.[0] ?? 0)
      if (n === 0) return 0
      await c.run(
        'UPDATE relationships SET weight = 0 WHERE from_id = ? AND to_id = ? AND type = ? AND weight > 0',
        [from, to, type]
      )
      return n
    })
  }

  async getSummary(): Promise<GraphSummary> {
    if (!this.ready) await this.open()
    const c = this.requireConn()

    const totalE = await c.runAndReadAll('SELECT COUNT(*) FROM entities')
    const totalR = await c.runAndReadAll('SELECT COUNT(*) FROM relationships WHERE weight > 0')

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
    const c = this.requireConn()
    const id = (await this.resolveEntityRef(entityId)) ?? slugify(entityId)

    const entityRows = await c.runAndReadAll(
      'SELECT id, name, type, doc_id, description FROM entities WHERE id = ?',
      [id]
    )
    const eRow = entityRows.getRows()[0]
    if (!eRow) return null

    const entity: GraphEntity = {
      id: String(eRow[0]),
      name: String(eRow[1]),
      type: eRow[2] as EntityType,
      docId: eRow[3] ? String(eRow[3]) : undefined,
      description: eRow[4] != null ? String(eRow[4]) : undefined,
    }

    const outRows = await c.runAndReadAll(
      `
      SELECT r.type, e.id, e.name, e.type
      FROM relationships r
      JOIN entities e ON r.to_id = e.id
      WHERE r.from_id = ? AND r.weight > 0
    `,
      [id]
    )

    const inRows = await c.runAndReadAll(
      `
      SELECT r.type, e.id, e.name, e.type
      FROM relationships r
      JOIN entities e ON r.from_id = e.id
      WHERE r.to_id = ? AND r.weight > 0
    `,
      [id]
    )

    return {
      entity,
      outgoing: outRows.getRows().map(r => ({
        rel: String(r[0]),
        target: { id: String(r[1]), name: String(r[2]), type: r[3] as EntityType },
      })),
      incoming: inRows.getRows().map(r => ({
        rel: String(r[0]),
        source: { id: String(r[1]), name: String(r[2]), type: r[3] as EntityType },
      })),
    }
  }

  /** Display name for a canonical entity id (falls back to the id string). */
  async getEntityNameById(entityId: string): Promise<string> {
    if (!this.ready) await this.open()
    const c = this.requireConn()
    const id = (await this.resolveEntityRef(entityId)) ?? slugify(entityId)
    const rows = await c.runAndReadAll('SELECT name FROM entities WHERE id = ?', [id])
    const row = rows.getRows()[0]
    return row ? String(row[0]) : entityId
  }

  /** Distinct relationship types on active edges from `fromId` to `toId` (directional). */
  async getDirectedEdgeLabelsBetween(fromId: string, toId: string): Promise<string[]> {
    if (!this.ready) await this.open()
    const c = this.requireConn()
    const from = (await this.resolveEntityRef(fromId)) ?? slugify(fromId)
    const to = (await this.resolveEntityRef(toId)) ?? slugify(toId)
    const rows = await c.runAndReadAll(
      `
      SELECT DISTINCT type
      FROM relationships
      WHERE from_id = ? AND to_id = ? AND weight > 0
      ORDER BY type
    `,
      [from, to]
    )
    return rows.getRows().map(r => String(r[0]))
  }

  async findPath(fromId: string, toId: string, maxDepth = 6): Promise<GraphPath | null> {
    if (!this.ready) await this.open()
    const c = this.requireConn()
    const from = (await this.resolveEntityRef(fromId)) ?? slugify(fromId)
    const to = (await this.resolveEntityRef(toId)) ?? slugify(toId)

    const result = await c.runAndReadAll(
      `
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
    `,
      [from, from, maxDepth, to]
    )

    const rows = result.getRows()
    if (rows.length === 0) return null

    const row = rows[0]
    const pathValue = row[0] as { items?: unknown[] }
    const nodes = (pathValue?.items ?? []).map(item => String(item ?? ''))
    return { nodes, hops: Number(row[1]) }
  }

  /**
   * Graph-backed query expansion: semantic **triplets** (subject / predicate / object) plus
   * adjacent entity names and standalone predicate labels. Used before lexical/hybrid retrieval
   * so queries can match documentation that states relationships explicitly or uses edge verbs.
   */
  async expandQuery(slugs: string[]): Promise<string[]> {
    if (!this.ready) await this.open()
    if (slugs.length === 0) return []

    const c = this.requireConn()
    const placeholders = slugs.map(() => '?').join(', ')
    const slugParams = [...slugs, ...slugs]

    const tripletRows = await c.runAndReadAll(
      `
      SELECT DISTINCT sf.name AS from_name, r.type AS rel_type, st.name AS to_name
      FROM relationships r
      JOIN entities sf ON sf.id = r.from_id
      JOIN entities st ON st.id = r.to_id
      WHERE r.weight > 0
        AND (sf.id IN (${placeholders}) OR st.id IN (${placeholders}))
    `,
      slugParams
    )

    const neighborRows = await c.runAndReadAll(
      `
      SELECT DISTINCT e.name
      FROM relationships r
      JOIN entities e ON (
        (r.from_id IN (${placeholders}) AND r.to_id = e.id)
        OR
        (r.to_id IN (${placeholders}) AND r.from_id = e.id)
      )
      WHERE r.weight > 0
    `,
      slugParams
    )

    const seen = new Set<string>()
    const out: string[] = []

    const add = (token: string) => {
      const t = token.trim()
      if (!t) return
      const key = t.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(t)
    }

    for (const row of tripletRows.getRows()) {
      const fromName = String(row[0] ?? '').trim()
      const rel = String(row[1] ?? '').trim()
      const toName = String(row[2] ?? '').trim()
      if (!fromName || !rel || !toName) continue
      const predPhrase = rel.replace(/_/g, ' ')
      add(`${fromName} ${predPhrase} ${toName}`)
      add(rel)
      if (predPhrase !== rel) add(predPhrase)
    }

    for (const row of neighborRows.getRows()) {
      const name = String(row[0] ?? '').trim()
      if (!name) continue
      if (slugs.includes(slugify(name))) continue
      add(name)
    }

    return out.slice(0, 40)
  }

  async scoreDocumentsForQuery(
    slugs: string[],
    docIds: string[]
  ): Promise<Map<string, GraphDocumentAffinity>> {
    if (!this.ready) await this.open()
    if (slugs.length === 0 || docIds.length === 0) return new Map()

    const c = this.requireConn()
    const slugPlaceholders = slugs.map(() => '?').join(', ')
    const docPlaceholders = docIds.map(() => '?').join(', ')

    const directRows = await c.runAndReadAll(
      `
      SELECT doc_id, name
      FROM entities
      WHERE id IN (${slugPlaceholders})
        AND doc_id IN (${docPlaceholders})
    `,
      [...slugs, ...docIds]
    )

    const oneHopRows = await c.runAndReadAll(
      `
      SELECT DISTINCT
        COALESCE(target.doc_id, r.doc_id) AS doc_id,
        source.name AS source_name,
        r.type AS rel_type,
        target.name AS target_name
      FROM relationships r
      JOIN entities source ON source.id = r.from_id
      JOIN entities target ON target.id = r.to_id
      WHERE r.weight > 0
        AND (
          (source.id IN (${slugPlaceholders}) AND COALESCE(target.doc_id, r.doc_id) IN (${docPlaceholders}))
          OR
          (target.id IN (${slugPlaceholders}) AND COALESCE(source.doc_id, r.doc_id) IN (${docPlaceholders}))
        )
    `,
      [...slugs, ...docIds, ...slugs, ...docIds]
    )

    const affinities = new Map<string, GraphDocumentAffinity>()

    for (const row of directRows.getRows()) {
      const docId = String(row[0] ?? '')
      if (!docId) continue
      affinities.set(docId, {
        boost: 1,
        evidence: [`direct:${String(row[1] ?? '')}`],
      })
    }

    for (const row of oneHopRows.getRows()) {
      const docId = String(row[0] ?? '')
      if (!docId) continue
      const current = affinities.get(docId)
      const evidence = `one-hop:${String(row[1] ?? '')}-[${String(row[2] ?? '')}]->${String(row[3] ?? '')}`
      if (!current) {
        affinities.set(docId, {
          boost: 0.6,
          evidence: [evidence],
        })
        continue
      }

      const mergedEvidence = current.evidence.includes(evidence)
        ? current.evidence
        : [...current.evidence, evidence]
      const boundedBoost = Math.min(
        1,
        Math.max(current.boost, 0.6) + (mergedEvidence.length > current.evidence.length ? 0.1 : 0)
      )
      affinities.set(docId, {
        boost: boundedBoost,
        evidence: mergedEvidence,
      })
    }

    return affinities
  }

  async exportDot(): Promise<string> {
    if (!this.ready) await this.open()
    const c = this.requireConn()
    const result = await c.runAndReadAll(`
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
    const c = this.requireConn()

    const eRows = await c.runAndReadAll('SELECT id, name, type, doc_id, description FROM entities')
    const rRows = await c.runAndReadAll(
      'SELECT from_id, to_id, type, doc_id, weight FROM relationships WHERE weight > 0'
    )

    return {
      entities: eRows.getRows().map(r => ({
        id: String(r[0]),
        name: String(r[1]),
        type: r[2] as EntityType,
        docId: r[3] ? String(r[3]) : undefined,
        description: r[4] != null ? String(r[4]) : undefined,
      })),
      relationships: rRows.getRows().map(r => ({
        fromId: String(r[0]),
        toId: String(r[1]),
        type: String(r[2]),
        docId: r[3] ? String(r[3]) : undefined,
        weight: Number(r[4]),
      })),
    }
  }

  async beginTransaction(): Promise<void> {
    if (this.transactionLockRelease) {
      throw new Error('DuckGraphWriter transaction already in progress')
    }
    this.transactionLockRelease = await this.acquireWriteLease()
    if (!this.ready) await this.openUnlocked()
    await this.requireConn().run('BEGIN TRANSACTION')
  }

  async commit(): Promise<void> {
    try {
      await this.requireConn().run('COMMIT')
    } finally {
      await this.releaseTransactionLock()
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.requireConn().run('ROLLBACK')
    } finally {
      await this.releaseTransactionLock()
    }
  }

  async close(): Promise<void> {
    if (this.conn) {
      if (this.transactionLockRelease) {
        try {
          await this.conn.run('ROLLBACK')
        } catch {
          // Best-effort cleanup for abandoned transactions.
        }
      }
      try {
        await this.conn.run('CHECKPOINT')
      } catch {
        // Best-effort flush; safe to ignore if already committed
      }
      try {
        this.conn.disconnect()
      } catch {
        // Best-effort disconnect.
      }
    }
    this.conn = null
    this.ready = false
    await this.releaseTransactionLock()
  }

  static dbPathForBase(baseDir: string): string {
    return path.join(baseDir, '.kb-graph.duckdb')
  }

  private async runWrite<T>(action: () => Promise<T>): Promise<T> {
    if (this.transactionLockRelease) {
      if (!this.ready) await this.openUnlocked()
      return action()
    }
    return this.withWriteLease(async () => {
      if (!this.ready) await this.openUnlocked()
      return action()
    })
  }

  private async withWriteLease<T>(action: () => Promise<T>): Promise<T> {
    const release = await this.acquireWriteLease()
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async acquireWriteLease(): Promise<() => Promise<void>> {
    const queueKey = this.dbPath
    const previous = DuckGraphWriter.writeQueueByPath.get(queueKey) ?? Promise.resolve()
    let releaseQueue!: () => void
    const current = new Promise<void>(resolve => {
      releaseQueue = resolve
    })
    DuckGraphWriter.writeQueueByPath.set(queueKey, previous.then(() => current, () => current))

    await previous.catch(() => {})
    const releaseFileLock = await acquireFilesystemWriteLock(this.dbPath)

    return async () => {
      try {
        await releaseFileLock()
      } finally {
        releaseQueue()
        if (DuckGraphWriter.writeQueueByPath.get(queueKey) === current) {
          DuckGraphWriter.writeQueueByPath.delete(queueKey)
        }
      }
    }
  }

  private async releaseTransactionLock(): Promise<void> {
    const release = this.transactionLockRelease
    this.transactionLockRelease = null
    if (release) {
      await release()
    }
  }
}

const WRITE_LOCK_TIMEOUT_MS = 10_000
const WRITE_LOCK_RETRY_DELAYS_MS = [15, 30, 60, 120, 250, 500]

async function acquireFilesystemWriteLock(dbPath: string): Promise<() => Promise<void>> {
  const lockPath = `${dbPath}.lock`
  const startedAt = Date.now()
  let attempt = 0

  while (true) {
    try {
      await mkdir(lockPath)
      return async () => {
        await rmdir(lockPath).catch(() => {})
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
      if (Date.now() - startedAt >= WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for DuckDB graph writer lock at ${lockPath}. Another graph write may still be running.`
        )
      }
      const delayMs =
        WRITE_LOCK_RETRY_DELAYS_MS[Math.min(attempt, WRITE_LOCK_RETRY_DELAYS_MS.length - 1)] ?? 500
      attempt += 1
      await sleep(delayMs)
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code === 'EEXIST'
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

/** Canonical entity id slug (same rules as stored `entities.id`). */
export function kbGraphEntityIdKey(text: string): string {
  return slugify(text)
}

/** Edge labels in the DB use snake_case (extractors + `kb graph edge`). */
function normalizeRelationshipTypeLabel(input: string): string {
  const t = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (t.length > 0 ? t : 'related_to').slice(0, 64)
}
