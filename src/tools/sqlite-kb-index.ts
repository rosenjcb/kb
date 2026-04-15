import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import dayjs from 'dayjs'
import Database from 'better-sqlite3'
import { classifyDocumentLane, type RetrievalLane } from './retrieval-lane-router'

interface ChunkRecord {
  chunkId: string
  chunkIndex: number
  lane: RetrievalLane
  headingPath: string
  chunkText: string
  tokenCount: number
}

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
  eventType:
    | 'submit'
    | 'validate'
    | 'dispute'
    | 'query'
    | 'chat'
    | 'publish'
    | 'init'
    | 'tool-call'
    | 'system'
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
}

export interface DocumentUpsertInput {
  id: string
  title: string
  content: string
  docType?: string | null
  lane: RetrievalLane
  tags?: string[]
  createdAt?: string
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
    this.initSchema()
  }

  upsertDocumentFromContent(filePath: string, content: string): void {
    const parsed = parseDocument(filePath, content)
    if (!parsed) return

    const now = dayjs().toISOString()
    const chunks = buildChunks(parsed.id, parsed.contentBody, parsed.lane)
    const contentHash = sha256(content)

    const upsertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, content, file_path, doc_type, lane, tags_json, content_hash, created_at, updated_at, indexed_at)
      VALUES (@id, @title, @content, @filePath, @docType, @lane, @tagsJson, @contentHash, @createdAt, @updatedAt, @indexedAt)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        content=excluded.content,
        file_path=excluded.file_path,
        doc_type=excluded.doc_type,
        lane=excluded.lane,
        tags_json=excluded.tags_json,
        content_hash=excluded.content_hash,
        updated_at=excluded.updated_at,
        indexed_at=excluded.indexed_at
    `)

    const deleteChunks = this.db.prepare('DELETE FROM chunks WHERE doc_id = ?')
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (chunk_id, doc_id, chunk_index, lane, heading_path, chunk_text, token_count)
      VALUES (@chunkId, @docId, @chunkIndex, @lane, @headingPath, @chunkText, @tokenCount)
    `)
    const insertFts = this.db.prepare(`
      INSERT INTO chunks_fts (chunk_id, doc_id, chunk_text)
      VALUES (@chunkId, @docId, @chunkText)
    `)
    const insertEmbedding = this.db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, model_id, dimensions, vector_json, embedded_at)
      VALUES (@chunkId, @modelId, @dimensions, @vectorJson, @embeddedAt)
    `)

    const upsertIndexState = this.db.prepare(`
      INSERT INTO index_state (key, value, updated_at)
      VALUES ('last_indexed_at', @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      upsertDocument.run({
        id: parsed.id,
        title: parsed.title,
        content,
        filePath,
        docType: parsed.docType,
        lane: parsed.lane,
        tagsJson: JSON.stringify(parsed.tags),
        contentHash,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        indexedAt: now,
      })

      deleteChunks.run(parsed.id)

      for (const chunk of chunks) {
        insertChunk.run({
          chunkId: chunk.chunkId,
          docId: parsed.id,
          chunkIndex: chunk.chunkIndex,
          lane: chunk.lane,
          headingPath: chunk.headingPath,
          chunkText: chunk.chunkText,
          tokenCount: chunk.tokenCount,
        })
        insertFts.run({
          chunkId: chunk.chunkId,
          docId: parsed.id,
          chunkText: chunk.chunkText,
        })

        const vector = buildDeterministicVector(chunk.chunkText, this.vectorDimensions)
        insertEmbedding.run({
          chunkId: chunk.chunkId,
          modelId: this.modelId,
          dimensions: this.vectorDimensions,
          vectorJson: JSON.stringify(vector),
          embeddedAt: now,
        })
      }

      upsertIndexState.run({ value: now, updatedAt: now })
    })

    tx()
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
          row.file_path,
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
      .prepare('SELECT content_hash FROM documents WHERE id = ?')
      .get(id) as { content_hash?: string } | undefined

    if (!row?.content_hash) return true
    return row.content_hash !== sha256(content)
  }

  removeDocument(documentId: string): void {
    const deleteDocument = this.db.prepare('DELETE FROM documents WHERE id = ?')
    const now = dayjs().toISOString()
    const upsertIndexState = this.db.prepare(`
      INSERT INTO index_state (key, value, updated_at)
      VALUES ('last_indexed_at', @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `)

    const tx = this.db.transaction(() => {
      deleteDocument.run(documentId)
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

  getRetrievalRankingHints(
    queryFingerprint: string,
    minOccurrences = 3,
  ): RetrievalRankingHint[] {
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

    this.db.prepare(`
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
    `).run({
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
    windowHours = 24,
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
      reasons.push(`too-many-low-precision-lanes:${lowPrecisionLanes.length}>${config.maxLowPrecisionLanes}`)
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
    windowHours = 24,
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
    const hybridFallbackRate = (hybrid.total ?? 0) > 0
      ? (hybrid.fallbackCount ?? 0) / hybrid.total
      : 0

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
      reasons.push(`overall-miss-rate-too-high:${overallMissRate.toFixed(2)}>${config.maxOverallMissRate}`)
    }

    if (hybridFallbackRate > config.maxHybridFallbackRate) {
      reasons.push(`hybrid-fallback-rate-too-high:${hybridFallbackRate.toFixed(2)}>${config.maxHybridFallbackRate}`)
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
      reasons: [`overall-success-rate-below-threshold:${overallSuccessRate.toFixed(2)}<${config.minOverallSuccessRate}`],
    }
  }

  close(): void {
    this.db.close()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        doc_type TEXT,
        lane TEXT,
        tags_json TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        lane TEXT,
        heading_path TEXT,
        chunk_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        UNIQUE (doc_id, chunk_index)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id,
        doc_id,
        chunk_text,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retrieval_miss_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        raw_query TEXT NOT NULL,
        stage TEXT NOT NULL,
        miss_reason TEXT NOT NULL,
        top_candidates_json TEXT NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_miss_events_fingerprint
        ON retrieval_miss_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_ranking_hints (
        query_fingerprint TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 0,
        hint_score REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (query_fingerprint, doc_id)
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_ranking_hints_fingerprint
        ON retrieval_ranking_hints(query_fingerprint, hint_score DESC);

      CREATE TABLE IF NOT EXISTS retrieval_checkpoint_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        confidence REAL NOT NULL,
        method TEXT NOT NULL,
        detail TEXT,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_stage
        ON retrieval_checkpoint_events(stage, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_fingerprint
        ON retrieval_checkpoint_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_lane_routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        primary_lane TEXT NOT NULL,
        routed_lanes_json TEXT NOT NULL,
        route_reason TEXT NOT NULL,
        used_fallback INTEGER NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        confidence REAL NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_lane
        ON retrieval_lane_routing_events(primary_lane, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_fingerprint
        ON retrieval_lane_routing_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_entries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date  TEXT NOT NULL,
        base          TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        metadata_json TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_entries_date
        ON session_entries(session_date DESC);

      CREATE INDEX IF NOT EXISTS idx_session_entries_base
        ON session_entries(base, session_date DESC);
    `)

    // Migration-safe columns for existing databases.
    this.ensureColumn('documents', 'lane', 'TEXT')
    this.ensureColumn('chunks', 'lane', 'TEXT')
    this.ensureColumn('documents', 'content', "TEXT NOT NULL DEFAULT ''")
  }

  // ─── Session Entry API ───────────────────────────────────────────

  insertSessionEntry(entry: SessionEntryInput): void {
    const now = dayjs().toISOString()
    this.db.prepare(`
      INSERT INTO session_entries (session_date, base, event_type, summary, metadata_json, created_at)
      VALUES (@sessionDate, @base, @eventType, @summary, @metadataJson, @createdAt)
    `).run({
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
    return this.db.prepare(`
      SELECT id, title, content, file_path, doc_type, lane, tags_json, created_at, updated_at
      FROM documents
      ORDER BY updated_at DESC
    `).all() as SqliteDocumentRow[]
  }

  getDocumentContent(id: string): string | undefined {
    const row = this.db.prepare(
      'SELECT content FROM documents WHERE id = ?'
    ).get(id) as { content?: string } | undefined
    return row?.content
  }

  upsertDocumentWithContent(input: DocumentUpsertInput): void {
    const now = dayjs().toISOString()
    const chunks = buildChunks(input.id, input.content, input.lane)
    const contentHash = sha256(input.content)

    const upsertDoc = this.db.prepare(`
      INSERT INTO documents (id, title, content, file_path, doc_type, lane, tags_json, content_hash, created_at, updated_at, indexed_at)
      VALUES (@id, @title, @content, @filePath, @docType, @lane, @tagsJson, @contentHash, @createdAt, @updatedAt, @indexedAt)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        content=excluded.content,
        file_path=excluded.file_path,
        doc_type=excluded.doc_type,
        lane=excluded.lane,
        tags_json=excluded.tags_json,
        content_hash=excluded.content_hash,
        updated_at=excluded.updated_at,
        indexed_at=excluded.indexed_at
    `)

    const deleteChunks = this.db.prepare('DELETE FROM chunks WHERE doc_id = ?')
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (chunk_id, doc_id, chunk_index, lane, heading_path, chunk_text, token_count)
      VALUES (@chunkId, @docId, @chunkIndex, @lane, @headingPath, @chunkText, @tokenCount)
    `)
    const insertFts = this.db.prepare(`
      INSERT INTO chunks_fts (chunk_id, doc_id, chunk_text)
      VALUES (@chunkId, @docId, @chunkText)
    `)
    const insertEmbedding = this.db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, model_id, dimensions, vector_json, embedded_at)
      VALUES (@chunkId, @modelId, @dimensions, @vectorJson, @embeddedAt)
    `)

    const tx = this.db.transaction(() => {
      upsertDoc.run({
        id: input.id,
        title: input.title,
        content: input.content,
        filePath: input.id,
        docType: input.docType ?? null,
        lane: input.lane,
        tagsJson: JSON.stringify(input.tags ?? []),
        contentHash,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        indexedAt: now,
      })

      deleteChunks.run(input.id)

      for (const chunk of chunks) {
        insertChunk.run({
          chunkId: chunk.chunkId,
          docId: input.id,
          chunkIndex: chunk.chunkIndex,
          lane: chunk.lane,
          headingPath: chunk.headingPath,
          chunkText: chunk.chunkText,
          tokenCount: chunk.tokenCount,
        })
        insertFts.run({
          chunkId: chunk.chunkId,
          docId: input.id,
          chunkText: chunk.chunkText,
        })

        const vector = buildDeterministicVector(chunk.chunkText, this.vectorDimensions)
        insertEmbedding.run({
          chunkId: chunk.chunkId,
          modelId: this.modelId,
          dimensions: this.vectorDimensions,
          vectorJson: JSON.stringify(Array.from(vector)),
          embeddedAt: now,
        })
      }
    })

    tx()
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some(col => col.name === column)) {
      return
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

interface ParsedDocument {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  tags: string[]
  docType: string | null
  lane: RetrievalLane
  contentBody: string
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
    ? tagsRaw.split(',').map(tag => tag.trim()).filter(Boolean)
    : []
  const lane = classifyDocumentLane(id, title, docType, tags, filePath)

  const metadataBlockEnd = findMetadataBlockEnd(lines)
  const bodyLines = lines.slice(metadataBlockEnd)
  const contentBody = bodyLines.join('\n').trim()

  return {
    id,
    title,
    createdAt,
    updatedAt: dayjs().toISOString(),
    tags,
    docType,
    lane,
    contentBody,
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

function findMetadataBlockEnd(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('Created:') || line.startsWith('Type:') || line.startsWith('Tags:')) {
      continue
    }
    return i
  }
  return lines.length
}

function buildChunks(documentId: string, body: string, lane: RetrievalLane): ChunkRecord[] {
  const fallbackText = body.trim() || 'No body content provided.'
  const sections = splitByHeading(fallbackText)

  const chunks: ChunkRecord[] = []
  let chunkIndex = 0

  for (const section of sections) {
    const slices = splitLongSection(section.text, 900)
    for (const slice of slices) {
      const text = slice.trim()
      if (!text) continue
      chunks.push({
        chunkId: `${documentId}:${chunkIndex}`,
        chunkIndex,
        lane,
        headingPath: section.heading,
        chunkText: text,
        tokenCount: text.split(/\s+/).filter(Boolean).length,
      })
      chunkIndex += 1
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      chunkId: `${documentId}:0`,
      chunkIndex: 0,
      lane,
      headingPath: 'document',
      chunkText: fallbackText,
      tokenCount: fallbackText.split(/\s+/).filter(Boolean).length,
    })
  }

  return chunks
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

function splitByHeading(body: string): Array<{ heading: string; text: string }> {
  const lines = body.split('\n')
  const sections: Array<{ heading: string; text: string }> = []

  let heading = 'document'
  let buffer: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const headingMatch = line.match(/^#{2,6}\s+(.+)$/)
    if (headingMatch) {
      if (buffer.join('\n').trim()) {
        sections.push({ heading, text: buffer.join('\n').trim() })
      }
      heading = headingMatch[1].trim().toLowerCase().replace(/\s+/g, '-')
      buffer = []
      continue
    }
    buffer.push(line)
  }

  if (buffer.join('\n').trim()) {
    sections.push({ heading, text: buffer.join('\n').trim() })
  }

  if (sections.length === 0) {
    sections.push({ heading: 'document', text: body })
  }

  return sections
}

function splitLongSection(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]

  const paragraphs = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }

    if (current) chunks.push(current)

    if (paragraph.length <= maxChars) {
      current = paragraph
      continue
    }

    for (let i = 0; i < paragraph.length; i += maxChars) {
      chunks.push(paragraph.slice(i, i + maxChars))
    }
    current = ''
  }

  if (current) chunks.push(current)
  return chunks.length ? chunks : [text]
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
