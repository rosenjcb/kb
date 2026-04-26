import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import Database from 'better-sqlite3'
import dayjs from 'dayjs'
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
  eventType: 'submit' | 'validate' | 'query' | 'chat' | 'publish' | 'init' | 'tool-call' | 'system'
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

export interface FactUpsertInput {
  factText: string
  sourceKind: 'submit' | 'init_readme' | 'import' | 'system'
  sourceRef?: string
  confidence?: number
  supersedesFactId?: string
}

export interface FactRow {
  id: string
  fact_text: string
  normalized_text: string
  source_kind: string
  source_ref: string | null
  confidence: number
  supersedes_fact_id: string | null
  tombstoned_at: string | null
  created_at: string
  updated_at: string
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
    const existing = this.db
      .prepare('SELECT id FROM facts WHERE normalized_text = ? AND tombstoned_at IS NULL')
      .get(normalized) as { id: string } | undefined

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE facts
          SET fact_text = ?, source_kind = ?, source_ref = ?, confidence = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          input.factText.trim(),
          input.sourceKind,
          input.sourceRef ?? null,
          input.confidence ?? 0.8,
          now,
          existing.id
        )
      this.rebuildFactIndexes(existing.id, input.factText.trim(), now)
      return { id: existing.id, operation: 'updated' }
    }

    const id = `fact-${sha256(`${normalized}:${now}`).slice(0, 16)}`
    this.db
      .prepare(
        `
        INSERT INTO facts (
          id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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
        now
      )
    this.rebuildFactIndexes(id, input.factText.trim(), now)
    return { id, operation: 'inserted' }
  }

  listFactsForQuery(limit = 20): FactRow[] {
    return this.db
      .prepare(
        `
        SELECT id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at
        FROM facts
        WHERE tombstoned_at IS NULL
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
    const ftsQuery = tokens.length > 0 ? tokens.join(' OR ') : trimmed

    try {
      const rows = this.db
        .prepare(
          `
          SELECT f.id, f.fact_text, f.normalized_text, f.source_kind, f.source_ref, f.confidence, f.supersedes_fact_id, f.tombstoned_at, f.created_at, f.updated_at
          FROM facts_fts fts
          JOIN facts f ON f.id = fts.fact_id
          WHERE facts_fts MATCH ?
            AND f.tombstoned_at IS NULL
          ORDER BY f.updated_at DESC
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
          SELECT id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at
          FROM facts
          WHERE tombstoned_at IS NULL
            AND lower(fact_text) LIKE ?
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
        SELECT id, fact_text, normalized_text, source_kind, source_ref, confidence, supersedes_fact_id, tombstoned_at, created_at, updated_at
        FROM facts
        WHERE tombstoned_at IS NULL
          AND (${where})
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(...likeValues, limit) as FactRow[]
  }

  invalidateFact(oldFact: string, replacementFact?: string): { changed: number; replacementId?: string } {
    const normalized = normalizeFactText(oldFact)
    const now = dayjs().toISOString()
    const row = this.db
      .prepare('SELECT id FROM facts WHERE normalized_text = ? AND tombstoned_at IS NULL')
      .get(normalized) as { id: string } | undefined
    if (!row) return { changed: 0 }

    this.db
      .prepare('UPDATE facts SET tombstoned_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, row.id)

    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM fact_embeddings WHERE fact_id = ?').run(row.id)

    if (!replacementFact?.trim()) {
      return { changed: 1 }
    }

    const replacement = this.upsertFact({
      factText: replacementFact,
      sourceKind: 'system',
      sourceRef: `invalidate:${row.id}`,
      supersedesFactId: row.id,
    })
    return { changed: 1, replacementId: replacement.id }
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

  listDocsForView(limit = 20): SqliteDocumentRow[] {
    const derived = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, id AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 0 AS is_original
        FROM derived_docs
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(limit) as SqliteDocumentRow[]
    const original = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(limit) as SqliteDocumentRow[]
    return [...derived, ...original].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit)
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
    const row = this.db
      .prepare('SELECT markdown FROM original_docs WHERE id = ?')
      .get(id) as
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

function normalizeFactText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenizeQuery(input: string): string[] {
  return [...new Set(input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2))].slice(0, 10)
}
