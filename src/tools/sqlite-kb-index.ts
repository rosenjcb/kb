import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import Database from 'better-sqlite3'
import dayjs from 'dayjs'
import type {
  FactCategoryCreatedBy,
  FactCategoryDefinitionInput,
  FactCategoryStatus,
} from '../core/fact-categories'
import { runMigrations } from '../core/db-migrations'
import { type RetrievalLane, classifyDocumentLane } from './retrieval-lane-router'

export interface SqliteKbIndexerOptions {
  dbPath: string
  modelId?: string
  vectorDimensions?: number
}

export interface RetrievalMissEventInput {
  queryFingerprint: string
  rawQuery: string
  stage: string
  missReason:
    | 'no_candidates'
    | 'low_confidence'
    | 'conflicting_sources'
    | 'latency_budget_exceeded'
    | 'provider_error'
  topCandidates: Array<{ id: string; score: number }>
  surface: 'chat' | 'intent-query' | 'intent-explain' | 'validator' | 'reader'
}

export interface RetrievalMissCluster {
  queryFingerprint: string
  missReason: string
  occurrences: number
  lastSeenAt: string
}

export interface RetrievalRankingHint {
  docId: string
  hintScore: number
  occurrences: number
}

interface LaneBackfillRow {
  id: string
  title: string
  file_path: string
  doc_type: string | null
  tags_json: string | null
}

export interface RetrievalCheckpointEventInput {
  queryFingerprint: string
  stage: string
  status: 'hit' | 'miss' | 'error'
  nextAction: 'return' | 'advance'
  confidence: number
  method: 'hybrid' | 'lexical' | 'lexical-fallback'
  detail?: string
  surface: 'chat' | 'intent-query' | 'intent-explain' | 'validator' | 'reader'
}

export interface LaneRoutingEventInput {
  queryFingerprint: string
  primaryLane: RetrievalLane
  routedLanes: RetrievalLane[]
  routeReason: string
  usedFallback: boolean
  status: 'hit' | 'miss' | 'error'
  nextAction: 'return' | 'advance'
  confidence: number
  surface: 'chat' | 'intent-query' | 'intent-explain' | 'validator' | 'reader'
}

export interface SessionEntryInput {
  sessionDate: string
  base: string
  eventType: 'validate' | 'query' | 'chat' | 'publish' | 'init' | 'tool-call' | 'system'
  summary: string
  metadata?: Record<string, unknown>
}

export interface SqliteDocumentRow {
  id: string
  title: string
  content: string
  file_path: string
  doc_type: string | null
  lane: string | null
  tags_json: string | null
  created_at: string
  updated_at: string
  is_original: number
}

export interface DocumentUpsertInput {
  id: string
  title: string
  content: string
  docType?: string | null
  lane: RetrievalLane
  tags?: string[]
  createdAt?: string
  isOriginal?: boolean
}

export interface FactTriplet {
  subject: string
  predicate: string
  object: string
}

export interface FactUpsertInput {
  factText: string
  /** Omitted or partial values → deterministic placeholder triple derived from `factText`. */
  triplet?: FactTriplet
  sourceKind: 'import_doc' | 'import_code'
  sourceRef?: string
  confidence?: number
  supersedesFactId?: string
  /** Raw source code snippet for import_code facts — stored and served to the LLM instead of verbose fact_text. */
  sourceText?: string
}

export interface FactRow {
  id: string
  fact_text: string
  normalized_text: string
  source_kind: string
  source_ref: string | null
  lane_id?: string
  confidence: number
  supersedes_fact_id: string | null
  tombstoned_at: string | null
  created_at: string
  updated_at: string
  subject: string
  predicate: string
  object: string
  source_text: string | null
}

export interface FactCategoryRow {
  id: string
  name: string
  description: string
  status: FactCategoryStatus
  created_by: FactCategoryCreatedBy
  representative_terms_json: string
  centroid_vector_json: string
  created_at: string
  updated_at: string
}

export interface FactCategoryAssignmentRow {
  fact_id: string
  category_id: string
  score: number
  created_at: string
  updated_at: string
}

export interface FactConceptRow {
  fact_id: string
  concept_id: string
  role: string
  score: number
  created_at: string
}

export interface DerivedDocUpsertInput {
  id: string
  title: string
  instruction: string
  markdown: string
  sourceFactIds: string[]
  status?: 'active' | 'archived'
  tags?: string[]
  docType?: string | null
}

export interface OriginalDocUpsertInput {
  id: string
  title: string
  markdown: string
  sourceRef?: string
  tags?: string[]
  docType?: string | null
}

export interface LaneRoutingMetrics {
  lane: RetrievalLane
  totalCount: number
  hitCount: number
  missCount: number
  errorCount: number
  fallbackCount: number
  successRate: number
  fallbackRate: number
}

export interface LaneRoutingRolloutThresholds {
  minSampleSize: number
  minLaneSuccessRate: number
  maxLaneFallbackRate: number
  maxLowPrecisionLanes: number
}

export interface LaneRoutingRolloutAssessment {
  decision: 'promote' | 'hold' | 'rollback'
  sampleSize: number
  lowPrecisionLanes: RetrievalLane[]
  highFallbackLanes: RetrievalLane[]
  reasons: string[]
}

export interface RetrievalStageMetrics {
  stage: string
  totalCount: number
  hitCount: number
  missCount: number
  errorCount: number
  advanceCount: number
  returnCount: number
  successRate: number
  fallbackRate: number
}

export interface RetrievalRolloutThresholds {
  minSampleSize: number
  minOverallSuccessRate: number
  maxOverallMissRate: number
  maxHybridFallbackRate: number
}

export interface RetrievalRolloutAssessment {
  decision: 'promote' | 'hold' | 'rollback'
  sampleSize: number
  overallSuccessRate: number
  overallMissRate: number
  hybridFallbackRate: number
  reasons: string[]
}

const DEFAULT_ROLLOUT_THRESHOLDS: RetrievalRolloutThresholds = {
  minSampleSize: 20,
  minOverallSuccessRate: 0.7,
  maxOverallMissRate: 0.25,
  maxHybridFallbackRate: 0.5,
}

const DEFAULT_LANE_ROUTING_THRESHOLDS: LaneRoutingRolloutThresholds = {
  minSampleSize: 20,
  minLaneSuccessRate: 0.55,
  maxLaneFallbackRate: 0.45,
  maxLowPrecisionLanes: 1,
}

/** `facts` row projection — keep aligned with `FactRow`. */
const FACT_ROW_SELECT =
  'id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at, subject, predicate, object, source_text'

const FACT_ROW_SELECT_F =
  'f.id, f.fact_text, f.normalized_text, f.source_kind, f.source_ref, f.confidence, f.supersedes_fact_id, f.tombstoned_at, f.created_at, f.updated_at, f.subject, f.predicate, f.object, f.source_text'

export class SqliteKbIndexer {
  private readonly db: Database.Database
  private readonly modelId: string
  private readonly vectorDimensions: number

  constructor(options: SqliteKbIndexerOptions) {
    this.db = new Database(options.dbPath)
    this.modelId = options.modelId ?? process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text'
    this.vectorDimensions = options.vectorDimensions ?? 64
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    runMigrations(this.db)
  }

  upsertFact(input: FactUpsertInput): { id: string; operation: 'inserted' | 'updated' } {
    const now = dayjs().toISOString()
    const normalized = normalizeFactText(input.factText)
    const raw = input.triplet
    let subject: string
    let predicate: string
    let object: string
    if (raw?.subject?.trim() && raw.predicate?.trim() && raw.object?.trim()) {
      subject = raw.subject.trim()
      predicate = raw.predicate.trim()
      object = raw.object.trim()
    } else {
      const o = input.factText.trim().replace(/\s+/g, ' ').slice(0, 400) || 'unspecified'
      subject = 'kb'
      predicate = 'asserts'
      object = o
    }
    const existing = this.db
      .prepare('SELECT id FROM facts WHERE normalized_text = ?')
      .get(normalized) as { id: string } | undefined

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE facts
          SET fact_text = ?, source_kind = ?, source_ref = ?, confidence = ?, updated_at = ?, subject = ?, predicate = ?, object = ?, source_text = ?
          WHERE id = ?
        `
        )
        .run(
          input.factText.trim(),
          input.sourceKind,
          input.sourceRef ?? null,
          input.confidence ?? 0.8,
          now,
          subject,
          predicate,
          object,
          input.sourceText ?? null,
          existing.id
        )
      this.rebuildFactIndexes(existing.id, input.factText.trim(), now)
      this.rebuildFactGraph(existing.id, input.factText.trim(), now)
      return { id: existing.id, operation: 'updated' }
    }

    const id = `fact-${sha256(`${normalized}:${now}`).slice(0, 16)}`
    this.db
      .prepare(
        `
        INSERT INTO facts (
          id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at, subject, predicate, object, source_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.factText.trim(),
        normalized,
        input.sourceKind,
        input.sourceRef ?? null,
        input.confidence ?? 0.8,
        input.supersedesFactId ?? null,
        now,
        now,
        subject,
        predicate,
        object,
        input.sourceText ?? null
      )
    this.rebuildFactIndexes(id, input.factText.trim(), now)
    this.rebuildFactGraph(id, input.factText.trim(), now)
    return { id, operation: 'inserted' }
  }

  /** Resolve a fact by normalized lowercase + collapsed whitespace match. */
  getActiveFactByTextMatch(factText: string): FactRow | undefined {
    const normalized = normalizeFactText(factText)
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        WHERE normalized_text = ?
        LIMIT 1
      `
      )
      .get(normalized) as FactRow | undefined
  }

  getActiveFactById(id: string): FactRow | undefined {
    const tid = id.trim()
    if (!tid) return undefined
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        WHERE id = ?
        LIMIT 1
      `
      )
      .get(tid) as FactRow | undefined
  }

  listFactsForQuery(limit = 20): FactRow[] {
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(limit) as FactRow[]
  }

  searchFacts(query: string, limit = 10): FactRow[] {
    const trimmed = query.trim()
    if (!trimmed) return this.listFactsForQuery(limit)
    const tokens = tokenizeQuery(trimmed)
    // Also include the camelCase-joined form so "agent OR loop" also matches the
    // single FTS5 token "agentloop" stored for symbols like "agentLoop".
    const joined = tokens.join('')
    const ftsTokens = joined.length > 2 && joined !== tokens.join(' ')
      ? [...new Set([...tokens, joined])]
      : tokens
    const ftsQuery = ftsTokens.length > 0 ? ftsTokens.join(' OR ') : trimmed

    try {
      const rows = this.db
        .prepare(
          `
          SELECT ${FACT_ROW_SELECT_F}
          FROM facts_fts fts
          JOIN facts f ON f.id = fts.fact_id
          WHERE facts_fts MATCH ?
           
          ORDER BY rank
          LIMIT ?
        `
        )
        .all(ftsQuery, limit) as FactRow[]
      if (rows.length > 0) return rows
    } catch {
      // fallback below
    }

    if (tokens.length === 0) {
      const like = `%${trimmed.toLowerCase()}%`
      return this.db
        .prepare(
          `
          SELECT ${FACT_ROW_SELECT}
          FROM facts
          WHERE             lower(fact_text) LIKE ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
        )
        .all(like, limit) as FactRow[]
    }

    const where = tokens.map(() => 'lower(fact_text) LIKE ?').join(' OR ')
    const likeValues = tokens.map(token => `%${token}%`)
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        WHERE           (${where})
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(...likeValues, limit) as FactRow[]
  }

  searchFactsByConcepts(conceptIds: string[], limit = 20): FactRow[] {
    const normalized = [...new Set(conceptIds.map(id => normalizeConceptId(id)).filter(Boolean))]
    if (normalized.length === 0) return []
    const placeholders = normalized.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT_F}
        FROM facts f
        JOIN fact_concepts fc ON fc.fact_id = f.id
        WHERE           fc.concept_id IN (${placeholders})
        ORDER BY f.updated_at DESC
        LIMIT ?
      `
      )
      .all(...normalized, limit) as FactRow[]
  }

  /**
   * Query-closure retrieval: union all facts touching any concept in frontier,
   * ranked by concept match strength first, then confidence/recency.
   */
  searchFactsByConceptFrontier(conceptIds: string[], limit = 20): FactRow[] {
    const normalized = [...new Set(conceptIds.map(id => normalizeConceptId(id)).filter(Boolean))]
    if (normalized.length === 0) return []
    const placeholders = normalized.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT_F}
        FROM facts f
        JOIN (
          SELECT
            fc.fact_id,
            COUNT(DISTINCT fc.concept_id) AS match_count
          FROM fact_concepts fc
          WHERE fc.concept_id IN (${placeholders})
          GROUP BY fc.fact_id
        ) m ON m.fact_id = f.id
        ORDER BY m.match_count DESC, f.confidence DESC, f.updated_at DESC
        LIMIT ?
      `
      )
      .all(...normalized, limit) as FactRow[]
  }

  semanticFactScores(query: string, factIds: string[]): Map<string, number> {
    const ids = [...new Set(factIds.map(id => id.trim()).filter(Boolean))]
    const out = new Map<string, number>()
    if (!query.trim() || ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `
        SELECT fact_id, vector_json, dimensions
        FROM fact_embeddings
        WHERE fact_id IN (${placeholders})
      `
      )
      .all(...ids) as Array<{ fact_id: string; vector_json?: string; dimensions?: number }>
    for (const row of rows) {
      if (!row.vector_json || !row.dimensions) continue
      try {
        const stored = JSON.parse(row.vector_json) as number[]
        if (!Array.isArray(stored) || stored.length !== row.dimensions) continue
        const queryVec = buildDeterministicVector(query, row.dimensions)
        const cosine = cosineSimilarity(queryVec, stored)
        out.set(row.fact_id, (cosine + 1) / 2)
      } catch {
        // ignore malformed embedding rows
      }
    }
    return out
  }

  listFactConcepts(factIds: string[]): FactConceptRow[] {
    const ids = [...new Set(factIds.map(id => id.trim()).filter(Boolean))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT fact_id, concept_id, role, score, created_at
        FROM fact_concepts
        WHERE fact_id IN (${placeholders})
      `
      )
      .all(...ids) as FactConceptRow[]
  }

  /** BFS neighbor lookup via fact_edges (both directions), excluding already-seen fact ids. */
  getFactNeighbors(factIds: string[], seen: Set<string>, limit = 80): FactRow[] {
    const ids = [...new Set(factIds.map(id => id.trim()).filter(Boolean))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const neighborRows = this.db
      .prepare(
        `
        SELECT DISTINCT to_fact_id AS neighbor_id FROM fact_edges WHERE from_fact_id IN (${placeholders})
        UNION
        SELECT DISTINCT from_fact_id AS neighbor_id FROM fact_edges WHERE to_fact_id IN (${placeholders})
      `
      )
      .all(...ids, ...ids) as Array<{ neighbor_id: string }>
    const boundedLimit = Math.max(1, Math.min(200, limit))
    const neighborIds = [
      ...new Set(
        neighborRows
          .map(row => row.neighbor_id?.trim())
          .filter((id): id is string => Boolean(id) && !seen.has(id))
      ),
    ].slice(0, boundedLimit)
    if (neighborIds.length === 0) return []
    const factPlaceholders = neighborIds.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        WHERE id IN (${factPlaceholders})
          AND tombstoned_at IS NULL
      `
      )
      .all(...neighborIds) as FactRow[]
  }

  expandNeighborConcepts(conceptIds: string[], hopLimit = 1, limit = 20): string[] {
    let frontier = [...new Set(conceptIds.map(id => normalizeConceptId(id)).filter(Boolean))]
    if (frontier.length === 0) return []
    const seen = new Set(frontier)
    const boundedHopLimit = Math.max(1, Math.min(3, hopLimit))
    const boundedLimit = Math.max(1, Math.min(100, limit))

    for (let hop = 0; hop < boundedHopLimit; hop++) {
      if (frontier.length === 0 || seen.size >= boundedLimit) break
      const placeholders = frontier.map(() => '?').join(', ')
      const neighbors = this.db
        .prepare(
          `
          SELECT DISTINCT fc2.concept_id AS concept_id
          FROM fact_concepts fc1
          JOIN fact_edges fe ON (fe.from_fact_id = fc1.fact_id OR fe.to_fact_id = fc1.fact_id)
          JOIN fact_concepts fc2 ON (fc2.fact_id = fe.from_fact_id OR fc2.fact_id = fe.to_fact_id)
          WHERE fc1.concept_id IN (${placeholders})
          LIMIT ?
        `
        )
        .all(...frontier, boundedLimit) as Array<{ concept_id: string }>
      const next: string[] = []
      for (const row of neighbors) {
        const concept = normalizeConceptId(row.concept_id)
        if (!concept || seen.has(concept)) continue
        seen.add(concept)
        next.push(concept)
        if (seen.size >= boundedLimit) break
      }
      frontier = next
    }

    return [...seen].slice(0, boundedLimit)
  }

  invalidateFact(
    oldFact: string,
    replacement?: { factText: string; triplet: FactTriplet }
  ): { changed: number; replacementId?: string } {
    const normalized = normalizeFactText(oldFact)
    const row = this.db
      .prepare('SELECT id FROM facts WHERE normalized_text = ?')
      .get(normalized) as { id: string } | undefined
    if (!row) return { changed: 0 }

    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM fact_embeddings WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM fact_concepts WHERE fact_id = ?').run(row.id)
    this.db
      .prepare('DELETE FROM fact_edges WHERE from_fact_id = ? OR to_fact_id = ?')
      .run(row.id, row.id)
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(row.id)

    if (!replacement?.factText?.trim()) {
      return { changed: 1 }
    }

    const replaced = this.upsertFact({
      factText: replacement.factText,
      triplet: replacement.triplet,
      sourceKind: 'import_code',
      sourceRef: `replace:${row.id}`,
      supersedesFactId: row.id,
    })
    return { changed: 1, replacementId: replaced.id }
  }

  /** Delete a fact row by id and clear all derived indexes. Returns true if a row was changed. */
  tombstoneFactById(factId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM facts WHERE id = ?')
      .get(factId) as { id: string } | undefined
    if (!row) return false
    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM fact_embeddings WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM fact_concepts WHERE fact_id = ?').run(row.id)
    this.db
      .prepare('DELETE FROM fact_edges WHERE from_fact_id = ? OR to_fact_id = ?')
      .run(row.id, row.id)
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(row.id)
    return true
  }

  /** Active facts whose `source_ref` exactly matches `sourceRef`. */
  listFactsBySourceRef(sourceRef: string): FactRow[] {
    return this.db
      .prepare(
        `SELECT ${FACT_ROW_SELECT} FROM facts WHERE source_ref = ?`
      )
      .all(sourceRef) as FactRow[]
  }

  /** Active facts whose `source_ref` starts with `prefix` (e.g. `code:src/foo.ts@`). */
  listActiveFactsBySourceRefPrefix(prefix: string): FactRow[] {
    return this.db
      .prepare(
        `SELECT ${FACT_ROW_SELECT} FROM facts WHERE source_ref LIKE ?`
      )
      .all(`${prefix}%`) as FactRow[]
  }

  /**
   * Wire `imports` facts directly to `exported_from` facts for the same file path.
   * This is a deterministic structural pass — AST import relationships are exact,
   * not token-similarity based. Returns the number of new edges created.
   */
  relinkCodeImportEdges(): number {
    const now = new Date().toISOString()
    const fwd = this.db.prepare(`
      INSERT OR IGNORE INTO fact_edges (from_fact_id, to_fact_id, edge_type, weight, created_at)
      SELECT imp.id, sym.id, 'imports_symbol', 1.0, ?
      FROM facts imp
      JOIN facts sym ON sym.object = imp.object
        AND sym.source_kind = 'import_code'
        AND sym.predicate = 'exported_from'
        AND sym.tombstoned_at IS NULL
      WHERE imp.source_kind = 'import_code'
        AND imp.predicate = 'imports'
        AND imp.tombstoned_at IS NULL
    `).run(now)
    const rev = this.db.prepare(`
      INSERT OR IGNORE INTO fact_edges (from_fact_id, to_fact_id, edge_type, weight, created_at)
      SELECT sym.id, imp.id, 'imports_symbol', 1.0, ?
      FROM facts imp
      JOIN facts sym ON sym.object = imp.object
        AND sym.source_kind = 'import_code'
        AND sym.predicate = 'exported_from'
        AND sym.tombstoned_at IS NULL
      WHERE imp.source_kind = 'import_code'
        AND imp.predicate = 'imports'
        AND imp.tombstoned_at IS NULL
    `).run(now)
    return fwd.changes + rev.changes
  }

  listFactCategories(): FactCategoryRow[] {
    return this.db
      .prepare(
        `
        SELECT id, name, description, status, created_by, representative_terms_json, centroid_vector_json, created_at, updated_at
        FROM fact_categories
        ORDER BY updated_at DESC, name ASC
      `
      )
      .all() as FactCategoryRow[]
  }

  replaceFactCategories(categories: FactCategoryDefinitionInput[]): void {
    const now = dayjs().toISOString()
    const deleteAssignments = this.db.prepare('DELETE FROM fact_category_assignments')
    const deleteMissing = this.db.prepare(
      categories.length > 0
        ? `DELETE FROM fact_categories WHERE id NOT IN (${categories.map(() => '?').join(', ')})`
        : 'DELETE FROM fact_categories'
    )
    const upsertCategory = this.db.prepare(`
      INSERT INTO fact_categories (
        id,
        name,
        description,
        status,
        created_by,
        representative_terms_json,
        centroid_vector_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        created_by = excluded.created_by,
        representative_terms_json = excluded.representative_terms_json,
        centroid_vector_json = excluded.centroid_vector_json,
        updated_at = excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      deleteAssignments.run()
      if (categories.length > 0) deleteMissing.run(...categories.map(category => category.id))
      else deleteMissing.run()
      for (const category of categories) {
        upsertCategory.run(
          category.id,
          category.name,
          category.description,
          category.status,
          category.createdBy,
          JSON.stringify(category.representativeTerms),
          JSON.stringify(category.centroidVector),
          now,
          now
        )
      }
    })

    tx()
  }

  replaceFactCategoryAssignments(
    assignments: Map<string, Array<{ categoryId: string; score: number }>>
  ): void {
    const now = dayjs().toISOString()
    const clear = this.db.prepare('DELETE FROM fact_category_assignments')
    const insert = this.db.prepare(`
      INSERT INTO fact_category_assignments (fact_id, category_id, score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, category_id) DO UPDATE SET
        score = excluded.score,
        updated_at = excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      clear.run()
      for (const [factId, rows] of assignments.entries()) {
        for (const row of rows) {
          insert.run(factId, row.categoryId, row.score, now, now)
        }
      }
    })

    tx()
  }

  mergeFactCategoryAssignments(
    assignments: Map<string, Array<{ categoryId: string; score: number }>>
  ): void {
    const now = dayjs().toISOString()
    const insert = this.db.prepare(`
      INSERT INTO fact_category_assignments (fact_id, category_id, score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, category_id) DO UPDATE SET
        score = excluded.score,
        updated_at = excluded.updated_at
    `)
    const tx = this.db.transaction(() => {
      for (const [factId, rows] of assignments.entries()) {
        for (const row of rows) {
          insert.run(factId, row.categoryId, row.score, now, now)
        }
      }
    })
    tx()
  }

  getFactCategoryNames(factId: string): string[] {
    return this.db
      .prepare(
        `
        SELECT c.name AS name
        FROM fact_category_assignments a
        JOIN fact_categories c ON c.id = a.category_id
        WHERE a.fact_id = ?
        ORDER BY a.score DESC, c.name ASC
      `
      )
      .all(factId)
      .map(row => String((row as { name: string }).name))
  }

  getFactCategoryNamesForFacts(factIds: string[]): Map<string, string[]> {
    const ids = [...new Set(factIds.map(id => id.trim()).filter(Boolean))]
    const out = new Map<string, string[]>()
    if (ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `
        SELECT a.fact_id AS fact_id, c.name AS name
        FROM fact_category_assignments a
        JOIN fact_categories c ON c.id = a.category_id
        WHERE a.fact_id IN (${placeholders})
        ORDER BY a.score DESC, c.name ASC
      `
      )
      .all(...ids) as Array<{ fact_id: string; name: string }>
    for (const row of rows) {
      if (!out.has(row.fact_id)) out.set(row.fact_id, [])
      out.get(row.fact_id)?.push(row.name)
    }
    return out
  }

  getFactCategoryIdsForFacts(factIds: string[]): Map<string, string[]> {
    const ids = [...new Set(factIds.map(id => id.trim()).filter(Boolean))]
    const out = new Map<string, string[]>()
    if (ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `
        SELECT fact_id, category_id
        FROM fact_category_assignments
        WHERE fact_id IN (${placeholders})
        ORDER BY score DESC, category_id ASC
      `
      )
      .all(...ids) as Array<{ fact_id: string; category_id: string }>
    for (const row of rows) {
      if (!out.has(row.fact_id)) out.set(row.fact_id, [])
      out.get(row.fact_id)?.push(row.category_id)
    }
    return out
  }

  inferCategoriesForQuery(query: string, limit = 3): Array<{ categoryId: string; name: string; score: number }> {
    const categories = this.listFactCategories()
    if (!query.trim() || categories.length === 0) return []
    const queryVector = buildDeterministicVector(query, this.vectorDimensions)
    return categories
      .map(category => {
        const centroid = parseVectorJsonSafe(category.centroid_vector_json)
        const termHits = parseTermsJsonSafe(category.representative_terms_json).filter(term =>
          query.toLowerCase().includes(term.toLowerCase())
        ).length
        const cosine =
          centroid.length === queryVector.length
            ? (cosineSimilarity(queryVector, centroid) + 1) / 2
            : 0
        return {
          categoryId: category.id,
          name: category.name,
          score: Math.min(1, cosine + termHits * 0.12),
        }
      })
      .filter(category => category.score >= 0.58)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  searchFactsInCategories(query: string, categoryIds: string[], limit = 10): FactRow[] {
    const ids = [...new Set(categoryIds.map(id => id.trim()).filter(Boolean))]
    if (ids.length === 0) return this.searchFacts(query, limit)
    const placeholders = ids.map(() => '?').join(', ')
    const tokens = tokenizeQuery(query.trim())
    const joined = tokens.join('')
    const ftsTokens =
      joined.length > 2 && joined !== tokens.join(' ') ? [...new Set([...tokens, joined])] : tokens
    const ftsQuery = ftsTokens.length > 0 ? ftsTokens.join(' OR ') : query.trim()
    try {
      const rows = this.db
        .prepare(
          `
          SELECT ${FACT_ROW_SELECT_F}
          FROM facts_fts fts
          JOIN facts f ON f.id = fts.fact_id
          JOIN fact_category_assignments a ON a.fact_id = f.id
          WHERE facts_fts MATCH ?
            AND a.category_id IN (${placeholders})
           
          ORDER BY a.score DESC, rank
          LIMIT ?
        `
        )
        .all(ftsQuery, ...ids, limit) as FactRow[]
      if (rows.length > 0) return rows
    } catch {
      // fallback below
    }

    const likeQuery = `%${query.trim().toLowerCase()}%`
    return this.db
      .prepare(
        `
        SELECT DISTINCT ${FACT_ROW_SELECT_F}
        FROM facts f
        JOIN fact_category_assignments a ON a.fact_id = f.id
        WHERE a.category_id IN (${placeholders})
         
          AND lower(f.fact_text) LIKE ?
        ORDER BY a.score DESC, f.updated_at DESC
        LIMIT ?
      `
      )
      .all(...ids, likeQuery, limit) as FactRow[]
  }

  searchFactsByConceptsInCategories(conceptIds: string[], categoryIds: string[], limit = 20): FactRow[] {
    const concepts = [...new Set(conceptIds.map(id => normalizeConceptId(id)).filter(Boolean))]
    const categories = [...new Set(categoryIds.map(id => id.trim()).filter(Boolean))]
    if (concepts.length === 0) return []
    if (categories.length === 0) return this.searchFactsByConcepts(concepts, limit)
    const conceptPlaceholders = concepts.map(() => '?').join(', ')
    const categoryPlaceholders = categories.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT DISTINCT ${FACT_ROW_SELECT_F}
        FROM facts f
        JOIN fact_concepts fc ON fc.fact_id = f.id
        JOIN fact_category_assignments a ON a.fact_id = f.id
        WHERE           fc.concept_id IN (${conceptPlaceholders})
          AND a.category_id IN (${categoryPlaceholders})
        ORDER BY a.score DESC, f.updated_at DESC
        LIMIT ?
      `
      )
      .all(...concepts, ...categories, limit) as FactRow[]
  }

  searchFactsByConceptFrontierInCategories(
    conceptIds: string[],
    categoryIds: string[],
    limit = 20
  ): FactRow[] {
    const concepts = [...new Set(conceptIds.map(id => normalizeConceptId(id)).filter(Boolean))]
    const categories = [...new Set(categoryIds.map(id => id.trim()).filter(Boolean))]
    if (concepts.length === 0) return []
    if (categories.length === 0) return this.searchFactsByConceptFrontier(concepts, limit)
    const conceptPlaceholders = concepts.map(() => '?').join(', ')
    const categoryPlaceholders = categories.map(() => '?').join(', ')
    return this.db
      .prepare(
        `
        SELECT DISTINCT ${FACT_ROW_SELECT_F}
        FROM facts f
        JOIN (
          SELECT
            fc.fact_id,
            COUNT(DISTINCT fc.concept_id) AS match_count
          FROM fact_concepts fc
          WHERE fc.concept_id IN (${conceptPlaceholders})
          GROUP BY fc.fact_id
        ) m ON m.fact_id = f.id
        JOIN fact_category_assignments a ON a.fact_id = f.id
        WHERE           a.category_id IN (${categoryPlaceholders})
        ORDER BY a.score DESC, m.match_count DESC, f.confidence DESC, f.updated_at DESC
        LIMIT ?
      `
      )
      .all(...concepts, ...categories, limit) as FactRow[]
  }

  listUncategorizedFacts(): FactRow[] {
    return this.db
      .prepare(
        `
        SELECT f.*
        FROM facts f
        WHERE           NOT EXISTS (
            SELECT 1
            FROM fact_category_assignments a
            WHERE a.fact_id = f.id
          )
        ORDER BY f.updated_at DESC
      `
      )
      .all() as FactRow[]
  }

  countUncategorizedFacts(): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM facts f
        WHERE           NOT EXISTS (
            SELECT 1
            FROM fact_category_assignments a
            WHERE a.fact_id = f.id
          )
      `
      )
      .get() as { count: number }
    return row.count
  }

  listFactCategoryStats(): Array<{ name: string; count: number }> {
    return this.db
      .prepare(
        `
        SELECT c.name AS name, COUNT(DISTINCT a.fact_id) AS count
        FROM fact_categories c
        LEFT JOIN fact_category_assignments a ON a.category_id = c.id
        GROUP BY c.id, c.name
        ORDER BY count DESC, c.name ASC
      `
      )
      .all() as Array<{ name: string; count: number }>
  }

  upsertDerivedDoc(input: DerivedDocUpsertInput): void {
    const now = dayjs().toISOString()
    this.db
      .prepare(
        `
        INSERT INTO derived_docs (id, title, instruction, markdown, source_fact_ids_json, status, tags_json, doc_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          instruction = excluded.instruction,
          markdown = excluded.markdown,
          source_fact_ids_json = excluded.source_fact_ids_json,
          status = excluded.status,
          tags_json = excluded.tags_json,
          doc_type = excluded.doc_type,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.id,
        input.title,
        input.instruction,
        input.markdown,
        JSON.stringify(input.sourceFactIds ?? []),
        input.status ?? 'active',
        JSON.stringify(input.tags ?? []),
        input.docType ?? null,
        now,
        now
      )
  }

  upsertOriginalDoc(input: OriginalDocUpsertInput): void {
    const now = dayjs().toISOString()
    this.db
      .prepare(
        `
        INSERT INTO original_docs (id, title, markdown, source_ref, tags_json, doc_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          markdown = excluded.markdown,
          source_ref = excluded.source_ref,
          tags_json = excluded.tags_json,
          doc_type = excluded.doc_type,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.id,
        input.title,
        input.markdown,
        input.sourceRef ?? null,
        JSON.stringify(input.tags ?? []),
        input.docType ?? null,
        now,
        now
      )
  }

  listDocsForView(limit?: number): SqliteDocumentRow[] {
    const derivedQuery =
      typeof limit === 'number'
        ? `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT ?
      `
        : `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        WHERE status = 'active'
        ORDER BY updated_at DESC
      `
    const originalQuery =
      typeof limit === 'number'
        ? `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        ORDER BY updated_at DESC
        LIMIT ?
      `
        : `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        ORDER BY updated_at DESC
      `
    const derived =
      typeof limit === 'number'
        ? (this.db.prepare(derivedQuery).all(limit) as SqliteDocumentRow[])
        : (this.db.prepare(derivedQuery).all() as SqliteDocumentRow[])
    const original =
      typeof limit === 'number'
        ? (this.db.prepare(originalQuery).all(limit) as SqliteDocumentRow[])
        : (this.db.prepare(originalQuery).all() as SqliteDocumentRow[])
    const combined = [...derived, ...original].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at)
    )
    return typeof limit === 'number' ? combined.slice(0, limit) : combined
  }

  getDocById(id: string): SqliteDocumentRow | undefined {
    const derived = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        WHERE id = ?
      `
      )
      .get(id) as SqliteDocumentRow | undefined
    if (derived) return derived
    return this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        WHERE id = ?
      `
      )
      .get(id) as SqliteDocumentRow | undefined
  }

  listPublishableDocs(): SqliteDocumentRow[] {
    const derived = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        WHERE status = 'active'
      `
      )
      .all() as SqliteDocumentRow[]
    const original = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
      `
      )
      .all() as SqliteDocumentRow[]
    return [...derived, ...original].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  listAllDocs(): SqliteDocumentRow[] {
    const derived = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        ORDER BY updated_at DESC
      `
      )
      .all() as SqliteDocumentRow[]
    const original = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        ORDER BY updated_at DESC
      `
      )
      .all() as SqliteDocumentRow[]
    return [...derived, ...original].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  private rebuildFactIndexes(factId: string, factText: string, now: string): void {
    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(factId)
    this.db
      .prepare('INSERT INTO facts_fts (fact_id, fact_text) VALUES (?, ?)')
      .run(factId, factText)

    const vector = buildDeterministicVector(factText, this.vectorDimensions)
    this.db
      .prepare(
        `
        INSERT INTO fact_embeddings (fact_id, model_id, dimensions, vector_json, embedded_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fact_id) DO UPDATE SET
          model_id = excluded.model_id,
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          embedded_at = excluded.embedded_at
      `
      )
      .run(factId, this.modelId, this.vectorDimensions, JSON.stringify(vector), now)
  }

  private rebuildFactGraph(factId: string, factText: string, now: string): void {
    const concepts = extractConcepts(factText)
    this.db.prepare('DELETE FROM fact_concepts WHERE fact_id = ?').run(factId)
    this.db
      .prepare('DELETE FROM fact_edges WHERE from_fact_id = ? OR to_fact_id = ?')
      .run(factId, factId)
    if (concepts.length === 0) return

    const upsertConcept = this.db.prepare(
      `
      INSERT INTO fact_concepts (fact_id, concept_id, role, score, created_at)
      VALUES (?, ?, 'context', 1.0, ?)
      ON CONFLICT(fact_id, concept_id, role) DO UPDATE SET
        score = excluded.score,
        created_at = excluded.created_at
    `
    )
    for (const concept of concepts) upsertConcept.run(factId, concept, now)

    const placeholders = concepts.map(() => '?').join(', ')
    const relatedFacts = this.db
      .prepare(
        `
        SELECT DISTINCT fc.fact_id
        FROM fact_concepts fc
        JOIN facts f ON f.id = fc.fact_id
        WHERE fc.concept_id IN (${placeholders})
          AND fc.fact_id != ?
         
        ORDER BY f.updated_at DESC
        LIMIT 12
      `
      )
      .all(...concepts, factId) as Array<{ fact_id: string }>

    const upsertEdge = this.db.prepare(
      `
      INSERT INTO fact_edges (from_fact_id, to_fact_id, edge_type, weight, created_at)
      VALUES (?, ?, 'concept_overlap', ?, ?)
      ON CONFLICT(from_fact_id, to_fact_id, edge_type) DO UPDATE SET
        weight = excluded.weight,
        created_at = excluded.created_at
    `
    )
    for (const row of relatedFacts) {
      upsertEdge.run(factId, row.fact_id, 1, now)
      upsertEdge.run(row.fact_id, factId, 1, now)
    }
  }

  upsertDocumentFromContent(filePath: string, content: string): void {
    const parsed = parseDocument(filePath, content)
    if (!parsed) return
    this.upsertOriginalDoc({
      id: parsed.id,
      title: parsed.title,
      markdown: content,
      sourceRef: filePath,
      tags: parsed.tags,
      docType: parsed.docType,
    })
  }

  close(): void {
    this.db.close()
  }

  backfillDocumentLanes(): number {
    const rows = this.db
      .prepare('SELECT id, title, file_path, doc_type, tags_json FROM documents')
      .all() as LaneBackfillRow[]

    const updateDocumentLane = this.db.prepare('UPDATE documents SET lane = ? WHERE id = ?')
    const updateChunkLane = this.db.prepare('UPDATE chunks SET lane = ? WHERE doc_id = ?')

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const lane = classifyDocumentLane(
          row.id,
          row.title,
          row.doc_type,
          parseTagsJsonSafe(row.tags_json),
          row.file_path
        )

        updateDocumentLane.run(lane, row.id)
        updateChunkLane.run(lane, row.id)
      }
    })

    tx()
    return rows.length
  }

  isDocumentStale(filePath: string, content: string): boolean {
    const id = basename(filePath, '.md')
    const row = this.db.prepare('SELECT markdown FROM original_docs WHERE id = ?').get(id) as
      | { markdown?: string }
      | undefined

    if (!row?.markdown) return true
    return sha256(row.markdown) !== sha256(content)
  }

  removeDocument(documentId: string): void {
    const deleteDerived = this.db.prepare('DELETE FROM derived_docs WHERE id = ?')
    const deleteOriginal = this.db.prepare('DELETE FROM original_docs WHERE id = ?')
    const now = dayjs().toISOString()
    const upsertIndexState = this.db.prepare(`
      INSERT INTO index_state (key, value, updated_at)
      VALUES ('last_indexed_at', @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      deleteDerived.run(documentId)
      deleteOriginal.run(documentId)
      upsertIndexState.run({ value: now, updatedAt: now })
    })

    tx()
  }

  recordRetrievalMissEvent(input: RetrievalMissEventInput): void {
    const now = dayjs().toISOString()

    const insertMissEvent = this.db.prepare(`
      INSERT INTO retrieval_miss_events (
        query_fingerprint,
        raw_query,
        stage,
        miss_reason,
        top_candidates_json,
        surface,
        created_at
      )
      VALUES (@queryFingerprint, @rawQuery, @stage, @missReason, @topCandidatesJson, @surface, @createdAt)
    `)

    const upsertHint = this.db.prepare(`
      INSERT INTO retrieval_ranking_hints (
        query_fingerprint,
        doc_id,
        occurrences,
        hint_score,
        updated_at
      )
      VALUES (@queryFingerprint, @docId, 1, @initialHintScore, @updatedAt)
      ON CONFLICT(query_fingerprint, doc_id) DO UPDATE SET
        occurrences = retrieval_ranking_hints.occurrences + 1,
        hint_score = MIN(1.0, retrieval_ranking_hints.hint_score + 0.1),
        updated_at = excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      insertMissEvent.run({
        queryFingerprint: input.queryFingerprint,
        rawQuery: input.rawQuery,
        stage: input.stage,
        missReason: input.missReason,
        topCandidatesJson: JSON.stringify(input.topCandidates),
        surface: input.surface,
        createdAt: now,
      })

      // Feedback loop: we only learn candidate affinity, and serving remains flag-gated.
      for (const candidate of input.topCandidates.slice(0, 5)) {
        upsertHint.run({
          queryFingerprint: input.queryFingerprint,
          docId: candidate.id,
          initialHintScore: 0.1,
          updatedAt: now,
        })
      }
    })

    tx()
  }

  listRetrievalMissClusters(limit = 20): RetrievalMissCluster[] {
    const rows = this.db
      .prepare(`
        SELECT
          query_fingerprint AS queryFingerprint,
          miss_reason AS missReason,
          COUNT(*) AS occurrences,
          MAX(created_at) AS lastSeenAt
        FROM retrieval_miss_events
        GROUP BY query_fingerprint, miss_reason
        ORDER BY occurrences DESC, lastSeenAt DESC
        LIMIT ?
      `)
      .all(limit) as RetrievalMissCluster[]

    return rows
  }

  getRetrievalRankingHints(queryFingerprint: string, minOccurrences = 3): RetrievalRankingHint[] {
    const rows = this.db
      .prepare(`
        SELECT
          doc_id AS docId,
          hint_score AS hintScore,
          occurrences AS occurrences
        FROM retrieval_ranking_hints
        WHERE query_fingerprint = ?
          AND occurrences >= ?
        ORDER BY hint_score DESC, occurrences DESC
        LIMIT 25
      `)
      .all(queryFingerprint, minOccurrences) as RetrievalRankingHint[]

    return rows
  }

  recordRetrievalCheckpointEvents(events: RetrievalCheckpointEventInput[]): void {
    if (events.length === 0) return

    const insertCheckpoint = this.db.prepare(`
      INSERT INTO retrieval_checkpoint_events (
        query_fingerprint,
        stage,
        status,
        next_action,
        confidence,
        method,
        detail,
        surface,
        created_at
      )
      VALUES (
        @queryFingerprint,
        @stage,
        @status,
        @nextAction,
        @confidence,
        @method,
        @detail,
        @surface,
        @createdAt
      )
    `)

    const now = dayjs().toISOString()
    const tx = this.db.transaction(() => {
      for (const event of events) {
        insertCheckpoint.run({
          queryFingerprint: event.queryFingerprint,
          stage: event.stage,
          status: event.status,
          nextAction: event.nextAction,
          confidence: event.confidence,
          method: event.method,
          detail: event.detail ?? null,
          surface: event.surface,
          createdAt: now,
        })
      }
    })

    tx()
  }

  recordLaneRoutingEvent(input: LaneRoutingEventInput): void {
    const now = dayjs().toISOString()

    this.db
      .prepare(`
      INSERT INTO retrieval_lane_routing_events (
        query_fingerprint,
        primary_lane,
        routed_lanes_json,
        route_reason,
        used_fallback,
        status,
        next_action,
        confidence,
        surface,
        created_at
      )
      VALUES (
        @queryFingerprint,
        @primaryLane,
        @routedLanesJson,
        @routeReason,
        @usedFallback,
        @status,
        @nextAction,
        @confidence,
        @surface,
        @createdAt
      )
    `)
      .run({
        queryFingerprint: input.queryFingerprint,
        primaryLane: input.primaryLane,
        routedLanesJson: JSON.stringify(input.routedLanes),
        routeReason: input.routeReason,
        usedFallback: input.usedFallback ? 1 : 0,
        status: input.status,
        nextAction: input.nextAction,
        confidence: input.confidence,
        surface: input.surface,
        createdAt: now,
      })
  }

  getLaneRoutingMetrics(windowHours = 24): LaneRoutingMetrics[] {
    const since = dayjs().subtract(windowHours, 'hour').toISOString()
    const rows = this.db
      .prepare(`
        SELECT
          primary_lane AS lane,
          COUNT(*) AS totalCount,
          SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hitCount,
          SUM(CASE WHEN status = 'miss' THEN 1 ELSE 0 END) AS missCount,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCount,
          SUM(CASE WHEN used_fallback = 1 THEN 1 ELSE 0 END) AS fallbackCount
        FROM retrieval_lane_routing_events
        WHERE created_at >= ?
        GROUP BY primary_lane
        ORDER BY totalCount DESC
      `)
      .all(since) as Array<{
      lane: RetrievalLane
      totalCount: number
      hitCount: number
      missCount: number
      errorCount: number
      fallbackCount: number
    }>

    return rows.map(row => ({
      ...row,
      successRate: row.totalCount > 0 ? row.hitCount / row.totalCount : 0,
      fallbackRate: row.totalCount > 0 ? row.fallbackCount / row.totalCount : 0,
    }))
  }

  evaluateLaneRoutingRollout(
    thresholds: Partial<LaneRoutingRolloutThresholds> = {},
    windowHours = 24
  ): LaneRoutingRolloutAssessment {
    const config: LaneRoutingRolloutThresholds = {
      ...DEFAULT_LANE_ROUTING_THRESHOLDS,
      ...thresholds,
    }

    const metrics = this.getLaneRoutingMetrics(windowHours)
    const sampleSize = metrics.reduce((sum, metric) => sum + metric.totalCount, 0)
    const reasons: string[] = []

    if (sampleSize < config.minSampleSize) {
      reasons.push(`sample-size-below-threshold:${sampleSize}<${config.minSampleSize}`)
      return {
        decision: 'hold',
        sampleSize,
        lowPrecisionLanes: [],
        highFallbackLanes: [],
        reasons,
      }
    }

    const lowPrecisionLanes = metrics
      .filter(metric => metric.successRate < config.minLaneSuccessRate)
      .map(metric => metric.lane)

    const highFallbackLanes = metrics
      .filter(metric => metric.fallbackRate > config.maxLaneFallbackRate)
      .map(metric => metric.lane)

    if (lowPrecisionLanes.length > config.maxLowPrecisionLanes) {
      reasons.push(
        `too-many-low-precision-lanes:${lowPrecisionLanes.length}>${config.maxLowPrecisionLanes}`
      )
    }

    if (highFallbackLanes.length > 0) {
      reasons.push(`lane-fallback-rate-too-high:${highFallbackLanes.join(',')}`)
    }

    if (reasons.length > 0) {
      return {
        decision: 'rollback',
        sampleSize,
        lowPrecisionLanes,
        highFallbackLanes,
        reasons,
      }
    }

    return {
      decision: 'promote',
      sampleSize,
      lowPrecisionLanes,
      highFallbackLanes,
      reasons: ['lane-thresholds-met'],
    }
  }

  getRetrievalStageMetrics(windowHours = 24): RetrievalStageMetrics[] {
    const since = dayjs().subtract(windowHours, 'hour').toISOString()
    const rows = this.db
      .prepare(`
        SELECT
          stage AS stage,
          COUNT(*) AS totalCount,
          SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hitCount,
          SUM(CASE WHEN status = 'miss' THEN 1 ELSE 0 END) AS missCount,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCount,
          SUM(CASE WHEN next_action = 'advance' THEN 1 ELSE 0 END) AS advanceCount,
          SUM(CASE WHEN next_action = 'return' THEN 1 ELSE 0 END) AS returnCount
        FROM retrieval_checkpoint_events
        WHERE created_at >= ?
        GROUP BY stage
        ORDER BY totalCount DESC
      `)
      .all(since) as Array<{
      stage: string
      totalCount: number
      hitCount: number
      missCount: number
      errorCount: number
      advanceCount: number
      returnCount: number
    }>

    return rows.map(row => ({
      ...row,
      successRate: row.totalCount > 0 ? row.hitCount / row.totalCount : 0,
      fallbackRate: row.totalCount > 0 ? row.advanceCount / row.totalCount : 0,
    }))
  }

  evaluateRetrievalRollout(
    thresholds: Partial<RetrievalRolloutThresholds> = {},
    windowHours = 24
  ): RetrievalRolloutAssessment {
    const config: RetrievalRolloutThresholds = {
      ...DEFAULT_ROLLOUT_THRESHOLDS,
      ...thresholds,
    }

    const since = dayjs().subtract(windowHours, 'hour').toISOString()

    const aggregate = this.db
      .prepare(`
        SELECT
          COUNT(*) AS sampleSize,
          SUM(CASE WHEN status = 'hit' AND next_action = 'return' THEN 1 ELSE 0 END) AS successCount,
          SUM(CASE WHEN status != 'hit' AND next_action = 'return' THEN 1 ELSE 0 END) AS missCount
        FROM retrieval_checkpoint_events
        WHERE created_at >= ?
      `)
      .get(since) as {
      sampleSize: number
      successCount: number
      missCount: number
    }

    const hybrid = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN next_action = 'advance' THEN 1 ELSE 0 END) AS fallbackCount
        FROM retrieval_checkpoint_events
        WHERE stage = 'hybrid_primary' AND created_at >= ?
      `)
      .get(since) as {
      total: number
      fallbackCount: number
    }

    const sampleSize = aggregate.sampleSize ?? 0
    const overallSuccessRate = sampleSize > 0 ? (aggregate.successCount ?? 0) / sampleSize : 0
    const overallMissRate = sampleSize > 0 ? (aggregate.missCount ?? 0) / sampleSize : 0
    const hybridFallbackRate =
      (hybrid.total ?? 0) > 0 ? (hybrid.fallbackCount ?? 0) / hybrid.total : 0

    const reasons: string[] = []

    if (sampleSize < config.minSampleSize) {
      reasons.push(`sample-size-below-threshold:${sampleSize}<${config.minSampleSize}`)
      return {
        decision: 'hold',
        sampleSize,
        overallSuccessRate,
        overallMissRate,
        hybridFallbackRate,
        reasons,
      }
    }

    if (overallMissRate > config.maxOverallMissRate) {
      reasons.push(
        `overall-miss-rate-too-high:${overallMissRate.toFixed(2)}>${config.maxOverallMissRate}`
      )
    }

    if (hybridFallbackRate > config.maxHybridFallbackRate) {
      reasons.push(
        `hybrid-fallback-rate-too-high:${hybridFallbackRate.toFixed(2)}>${config.maxHybridFallbackRate}`
      )
    }

    if (reasons.length > 0) {
      return {
        decision: 'rollback',
        sampleSize,
        overallSuccessRate,
        overallMissRate,
        hybridFallbackRate,
        reasons,
      }
    }

    if (overallSuccessRate >= config.minOverallSuccessRate) {
      return {
        decision: 'promote',
        sampleSize,
        overallSuccessRate,
        overallMissRate,
        hybridFallbackRate,
        reasons: ['thresholds-met'],
      }
    }

    return {
      decision: 'hold',
      sampleSize,
      overallSuccessRate,
      overallMissRate,
      hybridFallbackRate,
      reasons: [
        `overall-success-rate-below-threshold:${overallSuccessRate.toFixed(2)}<${config.minOverallSuccessRate}`,
      ],
    }
  }

  // ─── Session Entry API ───────────────────────────────────────────

  insertSessionEntry(entry: SessionEntryInput): void {
    const now = dayjs().toISOString()
    this.db
      .prepare(`
      INSERT INTO session_entries (session_date, base, event_type, summary, metadata_json, created_at)
      VALUES (@sessionDate, @base, @eventType, @summary, @metadataJson, @createdAt)
    `)
      .run({
        sessionDate: entry.sessionDate,
        base: entry.base,
        eventType: entry.eventType,
        summary: entry.summary,
        metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
        createdAt: now,
      })
  }

  getIndexStateValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM index_state WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return typeof row?.value === 'string' ? row.value : undefined
  }

  setIndexStateValue(key: string, value: string): void {
    const now = dayjs().toISOString()
    this.db
      .prepare(
        `
        INSERT INTO index_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
      )
      .run(key, value, now)
  }

  // ─── Document Content API (SQLite-exclusive read path) ───────────

  getAllDocumentsForLexical(): SqliteDocumentRow[] {
    return this.listPublishableDocs()
  }

  getDocumentIsOriginal(id: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM original_docs WHERE id = ?').get(id) as
      | { found?: number }
      | undefined
    return (row?.found ?? 0) === 1
  }

  getDocumentContent(id: string): string | undefined {
    const derived = this.db.prepare('SELECT markdown FROM derived_docs WHERE id = ?').get(id) as
      | { markdown?: string }
      | undefined
    if (derived?.markdown) return derived.markdown
    const original = this.db.prepare('SELECT markdown FROM original_docs WHERE id = ?').get(id) as
      | { markdown?: string }
      | undefined
    return original?.markdown
  }

  upsertDocumentWithContent(input: DocumentUpsertInput): void {
    const now = dayjs().toISOString()
    if (input.isOriginal) {
      this.upsertOriginalDoc({
        id: input.id,
        title: input.title,
        markdown: input.content,
        sourceRef: input.id,
        tags: input.tags ?? [],
        docType: input.docType ?? null,
      })
      return
    }

    this.upsertDerivedDoc({
      id: input.id,
      title: input.title,
      instruction: `legacy-write:${input.id}`,
      markdown: input.content,
      sourceFactIds: [],
      status: 'active',
      tags: input.tags ?? [],
      docType: input.docType ?? null,
    })

    this.db
      .prepare(`
      INSERT INTO index_state (key, value, updated_at)
      VALUES ('last_indexed_at', @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `)
      .run({ value: now, updatedAt: now })
  }
}

interface ParsedDocument {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  tags: string[]
  docType: string | null
}

function parseDocument(filePath: string, content: string): ParsedDocument | null {
  const lines = content.split('\n')
  if (!lines[0].startsWith('# ')) return null

  const title = lines[0].slice(2).trim() || 'Untitled'
  const id = basename(filePath, '.md')
  const createdAt = extractMetadata(lines, 'Created') ?? dayjs().toISOString()
  const docType = extractMetadata(lines, 'Type') ?? null
  const tagsRaw = extractMetadata(lines, 'Tags')
  const tags = tagsRaw
    ? tagsRaw
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    : []
  return {
    id,
    title,
    createdAt,
    updatedAt: dayjs().toISOString(),
    tags,
    docType,
  }
}

function extractMetadata(lines: string[], key: string): string | undefined {
  const prefix = `${key}:`
  for (let i = 0; i < Math.min(lines.length, 14); i++) {
    const line = lines[i].trim()
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim()
    }
  }
  return undefined
}

function parseTagsJsonSafe(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(tag => typeof tag === 'string') as string[]
  } catch {
    return []
  }
}

function parseTermsJsonSafe(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(term => typeof term === 'string') as string[]
  } catch {
    return []
  }
}

function parseVectorJsonSafe(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(value => typeof value === 'number') as number[]
  } catch {
    return []
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function buildDeterministicVector(input: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const bytes = createHash('sha256').update(input).digest()

  for (let i = 0; i < dimensions; i++) {
    const byte = bytes[i % bytes.length]
    vector[i] = (byte / 255) * 2 - 1
  }

  return normalize(vector)
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0))
  if (magnitude === 0) return values
  return values.map(value => value / magnitude)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  if (magA === 0 || magB === 0) return 0
  return dot / Math.sqrt(magA * magB)
}

/** Exported for tools that must match `facts.normalized_text` exactly. */
export function normalizeFactText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenizeQuery(input: string): string[] {
  const expanded = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return [
    ...new Set(
      expanded
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !FACT_STOP_WORDS.has(t))
    ),
  ].slice(0, 10)
}

const FACT_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'using',
  'where',
  'when',
  'what',
  'how',
  'are',
  'is',
  'was',
  'were',
  'your',
  'their',
  'have',
  'has',
])

function extractConcepts(input: string): string[] {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !FACT_STOP_WORDS.has(token))
  return [...new Set(tokens)].slice(0, 12).map(normalizeConceptId).filter(Boolean)
}

function normalizeConceptId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .trim()
}
