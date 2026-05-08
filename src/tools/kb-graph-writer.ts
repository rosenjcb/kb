/**
 * KbGraphWriter — knowledge graph in `.kb-index.sqlite` (kb_graph_* tables).
 *
 * Traversal uses recursive CTEs. Soft-delete on invalidate: weight = 0.
 */

import { mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../core/db-migrations'

const ENT = 'kb_graph_entities'
const REL = 'kb_graph_relationships'

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
  description?: string | null
}

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

export class KbGraphWriter {
  private static readonly writeQueueByPath = new Map<string, Promise<void>>()

  private db: Database.Database | null = null
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
    const db = new Database(this.dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 10000')
      runMigrations(db)
      this.db = db
      this.ready = true
    } catch (error) {
      try {
        db.close()
      } catch {
        // ignore
      }
      this.db = null
      this.ready = false
      throw error
    }
  }

  private requireDb(): Database.Database {
    const d = this.db
    if (!d) {
      throw new Error('KbGraphWriter must be opened before use')
    }
    return d
  }

  async upsertEntities(entities: GraphEntity[]): Promise<void> {
    await this.runWrite(() => {
      const db = this.requireDb()
      const now = new Date().toISOString()
      const stmt = db.prepare(`
        INSERT INTO ${ENT} (id, name, type, doc_id, description, created_at)
        VALUES (@id, @name, @type, NULLIF(@doc_id, ''), NULLIF(@description, ''), @created_at)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          doc_id = COALESCE(NULLIF(excluded.doc_id, ''), ${ENT}.doc_id),
          description = COALESCE(excluded.description, ${ENT}.description)
      `)
      for (const e of entities) {
        const id = slugify(e.id || e.name)
        const docBinding = (e.docId?.trim() ?? '') || ''
        const descBinding =
          e.description === undefined || e.description === null ? '' : String(e.description)
        stmt.run({
          id,
          name: e.name,
          type: e.type,
          doc_id: docBinding,
          description: descBinding,
          created_at: now,
        })
      }
    })
  }

  async upsertRelationships(relationships: GraphRelationship[]): Promise<void> {
    await this.runWrite(() => {
      const db = this.requireDb()
      const now = new Date().toISOString()
      const stub = db.prepare(`
        INSERT INTO ${ENT} (id, name, type, created_at)
        VALUES (?, ?, 'concept', ?)
        ON CONFLICT (id) DO NOTHING
      `)
      const insWithDoc = db.prepare(`
        INSERT INTO ${REL} (id, from_id, to_id, type, doc_id, weight, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          weight = MAX(${REL}.weight, excluded.weight),
          doc_id = excluded.doc_id
      `)
      const insNoDoc = db.prepare(`
        INSERT INTO ${REL} (id, from_id, to_id, type, weight, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          weight = MAX(${REL}.weight, excluded.weight)
      `)

      for (const r of relationships) {
        const fromId = this.resolveEntityRefSync(r.fromId) ?? slugify(r.fromId)
        const toId = this.resolveEntityRefSync(r.toId) ?? slugify(r.toId)
        const relType = normalizeRelationshipTypeLabel(r.type)
        const id = `${fromId}__${relType}__${toId}`
        stub.run(fromId, fromId, now)
        stub.run(toId, toId, now)
        if (r.docId) {
          insWithDoc.run(id, fromId, toId, relType, r.docId, r.weight ?? 1.0, now)
        } else {
          insNoDoc.run(id, fromId, toId, relType, r.weight ?? 1.0, now)
        }
      }
    })
  }

  async softDeleteByDocId(docId: string): Promise<number> {
    return this.runWrite(() => {
      const db = this.requireDb()
      db.prepare(`UPDATE ${REL} SET weight = 0 WHERE doc_id = ?`).run(docId)
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${REL} WHERE doc_id = ? AND weight = 0`)
        .get(docId) as { n: number }
      return Number(row?.n ?? 0)
    })
  }

  async resolveEntityRef(ref: string): Promise<string | null> {
    if (!this.ready) await this.open()
    return this.resolveEntityRefSync(ref)
  }

  private resolveEntityRefSync(ref: string): string | null {
    const db = this.requireDb()
    const trimmed = ref.trim()
    if (!trimmed) return null

    const slug = slugify(trimmed)
    if (slug) {
      const byId = db.prepare(`SELECT id FROM ${ENT} WHERE id = ?`).get(slug) as
        | { id: string }
        | undefined
      if (byId) return byId.id
    }

    const byName = db
      .prepare(`SELECT id FROM ${ENT} WHERE lower(name) = lower(?) LIMIT 1`)
      .get(trimmed) as { id: string } | undefined
    return byName ? byName.id : null
  }

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
    const db = this.requireDb()
    db.prepare(`UPDATE ${ENT} SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return true
  }

  async softDeleteEdge(fromId: string, toId: string, relType: string): Promise<number> {
    return this.runWrite(() => {
      const db = this.requireDb()
      const from = this.resolveEntityRefSync(fromId) ?? slugify(fromId)
      const to = this.resolveEntityRefSync(toId) ?? slugify(toId)
      const type = normalizeRelationshipTypeLabel(relType)
      const before = db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${REL} WHERE from_id = ? AND to_id = ? AND type = ? AND weight > 0`
        )
        .get(from, to, type) as { n: number }
      const n = Number(before?.n ?? 0)
      if (n === 0) return 0
      db.prepare(
        `UPDATE ${REL} SET weight = 0 WHERE from_id = ? AND to_id = ? AND type = ? AND weight > 0`
      ).run(from, to, type)
      return n
    })
  }

  async getSummary(): Promise<GraphSummary> {
    if (!this.ready) await this.open()
    const db = this.requireDb()

    const totalE = db.prepare(`SELECT COUNT(*) AS n FROM ${ENT}`).get() as { n: number }
    const totalR = db.prepare(`SELECT COUNT(*) AS n FROM ${REL} WHERE weight > 0`).get() as {
      n: number
    }

    const top = db
      .prepare(
        `
      SELECT e.id, e.name, e.type, COUNT(*) AS connections
      FROM ${ENT} e
      JOIN (
        SELECT from_id AS entity_id FROM ${REL} WHERE weight > 0
        UNION ALL
        SELECT to_id AS entity_id FROM ${REL} WHERE weight > 0
      ) r ON e.id = r.entity_id
      GROUP BY e.id, e.name, e.type
      ORDER BY connections DESC
      LIMIT 20
    `
      )
      .all() as Array<{ id: string; name: string; type: string; connections: number }>

    return {
      totalEntities: Number(totalE?.n ?? 0),
      totalRelationships: Number(totalR?.n ?? 0),
      topEntities: top.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type,
        connections: Number(row.connections),
      })),
    }
  }

  async getNeighbors(entityId: string): Promise<GraphNeighbors | null> {
    if (!this.ready) await this.open()
    const db = this.requireDb()
    const id = (await this.resolveEntityRef(entityId)) ?? slugify(entityId)

    const eRow = db
      .prepare(`SELECT id, name, type, doc_id, description FROM ${ENT} WHERE id = ?`)
      .get(id) as
      | {
          id: string
          name: string
          type: string
          doc_id: string | null
          description: string | null
        }
      | undefined
    if (!eRow) return null

    const entity: GraphEntity = {
      id: eRow.id,
      name: eRow.name,
      type: eRow.type as EntityType,
      docId: eRow.doc_id ? String(eRow.doc_id) : undefined,
      description: eRow.description != null ? String(eRow.description) : undefined,
    }

    const outMapped = db
      .prepare(
        `
      SELECT r.type, e.id, e.name, e.type AS etype
      FROM ${REL} r
      JOIN ${ENT} e ON r.to_id = e.id
      WHERE r.from_id = ? AND r.weight > 0
    `
      )
      .all(id) as Array<{ type: string; id: string; name: string; etype: string }>

    const inMapped = db
      .prepare(
        `
      SELECT r.type, e.id, e.name, e.type AS etype
      FROM ${REL} r
      JOIN ${ENT} e ON r.from_id = e.id
      WHERE r.to_id = ? AND r.weight > 0
    `
      )
      .all(id) as Array<{ type: string; id: string; name: string; etype: string }>

    return {
      entity,
      outgoing: outMapped.map(r => ({
        rel: String(r.type),
        target: { id: r.id, name: r.name, type: r.etype as EntityType },
      })),
      incoming: inMapped.map(r => ({
        rel: String(r.type),
        source: { id: r.id, name: r.name, type: r.etype as EntityType },
      })),
    }
  }

  async getEntityNameById(entityId: string): Promise<string> {
    if (!this.ready) await this.open()
    const db = this.requireDb()
    const id = (await this.resolveEntityRef(entityId)) ?? slugify(entityId)
    const row = db.prepare(`SELECT name FROM ${ENT} WHERE id = ?`).get(id) as
      | { name: string }
      | undefined
    return row ? row.name : entityId
  }

  async getDirectedEdgeLabelsBetween(fromId: string, toId: string): Promise<string[]> {
    if (!this.ready) await this.open()
    const db = this.requireDb()
    const from = (await this.resolveEntityRef(fromId)) ?? slugify(fromId)
    const to = (await this.resolveEntityRef(toId)) ?? slugify(toId)
    const rows = db
      .prepare(
        `
      SELECT DISTINCT type
      FROM ${REL}
      WHERE from_id = ? AND to_id = ? AND weight > 0
      ORDER BY type
    `
      )
      .all(from, to) as Array<{ type: string }>
    return rows.map(r => r.type)
  }

  async findPath(fromId: string, toId: string, maxDepth = 6): Promise<GraphPath | null> {
    if (!this.ready) await this.open()
    const db = this.requireDb()
    const from = (await this.resolveEntityRef(fromId)) ?? slugify(fromId)
    const to = (await this.resolveEntityRef(toId)) ?? slugify(toId)

    const row = db
      .prepare(
        `
      WITH RECURSIVE reach(node, depth, path_ids) AS (
        SELECT ? AS node, 0 AS depth, ? AS path_ids
        UNION ALL
        SELECT r.to_id, reach.depth + 1, reach.path_ids || ',' || r.to_id
        FROM ${REL} r
        JOIN reach ON r.from_id = reach.node
        WHERE reach.depth < ?
          AND r.weight > 0
          AND instr(',' || reach.path_ids || ',', ',' || r.to_id || ',') = 0
      )
      SELECT path_ids, depth FROM reach WHERE node = ?
      ORDER BY depth ASC LIMIT 1
    `
      )
      .get(from, from, maxDepth, to) as { path_ids: string; depth: number } | undefined

    if (!row) return null
    const nodes = row.path_ids.split(',').filter(Boolean)
    return { nodes, hops: Number(row.depth) }
  }

  async expandQuery(slugs: string[]): Promise<string[]> {
    if (!this.ready) await this.open()
    if (slugs.length === 0) return []

    const db = this.requireDb()
    const placeholders = slugs.map(() => '?').join(', ')
    const slugParams = [...slugs, ...slugs]

    const tripletRows = db
      .prepare(
        `
      SELECT DISTINCT sf.name AS from_name, r.type AS rel_type, st.name AS to_name
      FROM ${REL} r
      JOIN ${ENT} sf ON sf.id = r.from_id
      JOIN ${ENT} st ON st.id = r.to_id
      WHERE r.weight > 0
        AND (sf.id IN (${placeholders}) OR st.id IN (${placeholders}))
    `
      )
      .all(...slugParams) as Array<{ from_name: string; rel_type: string; to_name: string }>

    const neighborRows = db
      .prepare(
        `
      SELECT DISTINCT e.name
      FROM ${REL} r
      JOIN ${ENT} e ON (
        (r.from_id IN (${placeholders}) AND r.to_id = e.id)
        OR
        (r.to_id IN (${placeholders}) AND r.from_id = e.id)
      )
      WHERE r.weight > 0
    `
      )
      .all(...slugParams) as Array<{ name: string }>

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

    for (const row of tripletRows) {
      const fromName = String(row.from_name ?? '').trim()
      const rel = String(row.rel_type ?? '').trim()
      const toName = String(row.to_name ?? '').trim()
      if (!fromName || !rel || !toName) continue
      const predPhrase = rel.replace(/_/g, ' ')
      add(`${fromName} ${predPhrase} ${toName}`)
      add(rel)
      if (predPhrase !== rel) add(predPhrase)
    }

    for (const row of neighborRows) {
      const name = String(row.name ?? '').trim()
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

    const db = this.requireDb()
    const slugPlaceholders = slugs.map(() => '?').join(', ')
    const docPlaceholders = docIds.map(() => '?').join(', ')

    const directRows = db
      .prepare(
        `
      SELECT doc_id, name
      FROM ${ENT}
      WHERE id IN (${slugPlaceholders})
        AND doc_id IN (${docPlaceholders})
    `
      )
      .all(...slugs, ...docIds) as Array<{ doc_id: string; name: string }>

    const oneHopRows = db
      .prepare(
        `
      SELECT DISTINCT
        COALESCE(target.doc_id, r.doc_id) AS doc_id,
        source.name AS source_name,
        r.type AS rel_type,
        target.name AS target_name
      FROM ${REL} r
      JOIN ${ENT} source ON source.id = r.from_id
      JOIN ${ENT} target ON target.id = r.to_id
      WHERE r.weight > 0
        AND (
          (source.id IN (${slugPlaceholders}) AND COALESCE(target.doc_id, r.doc_id) IN (${docPlaceholders}))
          OR
          (target.id IN (${slugPlaceholders}) AND COALESCE(source.doc_id, r.doc_id) IN (${docPlaceholders}))
        )
    `
      )
      .all(...slugs, ...docIds, ...slugs, ...docIds) as Array<{
      doc_id: string
      source_name: string
      rel_type: string
      target_name: string
    }>

    const affinities = new Map<string, GraphDocumentAffinity>()

    for (const row of directRows) {
      const docId = String(row.doc_id ?? '')
      if (!docId) continue
      affinities.set(docId, {
        boost: 1,
        evidence: [`direct:${String(row.name ?? '')}`],
      })
    }

    for (const row of oneHopRows) {
      const docId = String(row.doc_id ?? '')
      if (!docId) continue
      const current = affinities.get(docId)
      const evidence = `one-hop:${String(row.source_name ?? '')}-[${String(row.rel_type ?? '')}]->${String(row.target_name ?? '')}`
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
    const db = this.requireDb()
    const rows = db
      .prepare(
        `
      SELECT e1.name AS n1, r.type AS rt, e2.name AS n2
      FROM ${REL} r
      JOIN ${ENT} e1 ON r.from_id = e1.id
      JOIN ${ENT} e2 ON r.to_id = e2.id
      WHERE r.weight > 0
    `
      )
      .all() as Array<{ n1: string; rt: string; n2: string }>

    const lines = ['digraph kb_graph {', '  rankdir=LR;']
    for (const row of rows) {
      const from = String(row.n1).replace(/"/g, '\\"')
      const rel = String(row.rt)
      const to = String(row.n2).replace(/"/g, '\\"')
      lines.push(`  "${from}" -> "${to}" [label="${rel}"];`)
    }
    lines.push('}')
    return lines.join('\n')
  }

  async exportJson(): Promise<{ entities: GraphEntity[]; relationships: GraphRelationship[] }> {
    if (!this.ready) await this.open()
    const db = this.requireDb()

    const eRows = db
      .prepare(`SELECT id, name, type, doc_id, description FROM ${ENT}`)
      .all() as Array<{
      id: string
      name: string
      type: string
      doc_id: string | null
      description: string | null
    }>
    const rRows = db
      .prepare(`SELECT from_id, to_id, type, doc_id, weight FROM ${REL} WHERE weight > 0`)
      .all() as Array<{
      from_id: string
      to_id: string
      type: string
      doc_id: string | null
      weight: number
    }>

    return {
      entities: eRows.map(r => ({
        id: r.id,
        name: r.name,
        type: r.type as EntityType,
        docId: r.doc_id ? String(r.doc_id) : undefined,
        description: r.description != null ? String(r.description) : undefined,
      })),
      relationships: rRows.map(r => ({
        fromId: r.from_id,
        toId: r.to_id,
        type: r.type,
        docId: r.doc_id ? String(r.doc_id) : undefined,
        weight: Number(r.weight),
      })),
    }
  }

  async beginTransaction(): Promise<void> {
    if (this.transactionLockRelease) {
      throw new Error('KbGraphWriter transaction already in progress')
    }
    this.transactionLockRelease = await this.acquireWriteLease()
    if (!this.ready) await this.openUnlocked()
    this.requireDb().prepare('BEGIN').run()
  }

  async commit(): Promise<void> {
    try {
      this.requireDb().prepare('COMMIT').run()
    } finally {
      await this.releaseTransactionLock()
    }
  }

  async rollback(): Promise<void> {
    try {
      this.requireDb().prepare('ROLLBACK').run()
    } finally {
      await this.releaseTransactionLock()
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      if (this.transactionLockRelease) {
        try {
          this.db.prepare('ROLLBACK').run()
        } catch {
          // Best-effort cleanup for abandoned transactions.
        }
      }
      try {
        this.db.close()
      } catch {
        // ignore
      }
    }
    this.db = null
    this.ready = false
    await this.releaseTransactionLock()
  }

  static dbPathForBase(baseDir: string): string {
    return path.join(baseDir, '.kb-index.sqlite')
  }

  private async runWrite<T>(action: () => T): Promise<T> {
    if (this.transactionLockRelease) {
      if (!this.ready) await this.openUnlocked()
      return action()
    }
    return this.withWriteLease(async () => {
      if (!this.ready) await this.openUnlocked()
      return action()
    })
  }

  private async withWriteLease<T>(action: () => T | Promise<T>): Promise<T> {
    const release = await this.acquireWriteLease()
    try {
      return await Promise.resolve(action())
    } finally {
      await release()
    }
  }

  private async acquireWriteLease(): Promise<() => Promise<void>> {
    const queueKey = this.dbPath
    const previous = KbGraphWriter.writeQueueByPath.get(queueKey) ?? Promise.resolve()
    let releaseQueue!: () => void
    const current = new Promise<void>(resolve => {
      releaseQueue = resolve
    })
    KbGraphWriter.writeQueueByPath.set(
      queueKey,
      previous.then(
        () => current,
        () => current
      )
    )

    await previous.catch(() => {})
    const lockPath = `${this.dbPath}.graph-write.lock`
    const releaseFileLock = await acquireFilesystemWriteLock(lockPath)

    return async () => {
      try {
        await releaseFileLock()
      } finally {
        releaseQueue()
        if (KbGraphWriter.writeQueueByPath.get(queueKey) === current) {
          KbGraphWriter.writeQueueByPath.delete(queueKey)
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

async function acquireFilesystemWriteLock(lockPath: string): Promise<() => Promise<void>> {
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
          `Timed out waiting for KB graph writer lock at ${lockPath}. Another graph write may still be running.`
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

export function kbGraphEntityIdKey(text: string): string {
  return slugify(text)
}

function normalizeRelationshipTypeLabel(input: string): string {
  const t = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (t.length > 0 ? t : 'related_to').slice(0, 64)
}
