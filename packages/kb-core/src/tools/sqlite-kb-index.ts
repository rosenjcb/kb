import type { EvidenceLabel } from '../core/evidence-label'
import { isOpenableSourcePath } from '../core/fact-uri'
import { DEFAULT_FACT_EVIDENCE, type FactEvidenceKind } from '../core/fact-evidence'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import dayjs from 'dayjs'
import { resolveEmbedFetchPageSize } from '../config/indexing-batch-size'
import { runMigrations } from '../core/db-migrations'
import type { Embedder } from '../core/embeddings'
import type { RetrievalLane } from './retrieval-lane-router'

function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface SqliteKbIndexerOptions {
  dbPath: string
  modelId?: string
  vectorDimensions?: number
  /** Optional real embedder; enables neural semantic scoring in place of the hash proxy. */
  embedder?: Embedder
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

export interface RetrievalCheckpointEventInput {
  queryFingerprint: string
  stage: string
  status: 'hit' | 'miss' | 'error'
  nextAction: 'return' | 'advance'
  evidence: EvidenceLabel
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
  evidence: EvidenceLabel
  surface: 'chat' | 'intent-query' | 'intent-explain' | 'validator' | 'reader'
}

export interface SessionEntryInput {
  sessionDate: string
  base: string
  eventType: 'validate' | 'query' | 'chat' | 'init' | 'tool-call' | 'system'
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

/**
 * Curated fact write. `facts` is no longer a derived sentence store — it holds only
 * user/curated assertions, so the `sourceKind` field the sentence pipeline used to supply
 * is accepted and ignored by the legacy `upsertFact` shim.
 */
export interface FactUpsertInput {
  factText: string
  sourceKind?: 'import_doc' | 'import_code'
  sourceRef?: string
  /** What kind of evidence this fact is — see `core/fact-evidence`. */
  evidence?: FactEvidenceKind
  supersedesFactId?: string
  sourceText?: string
  /** Slug of the git repo this fact was indexed from (multi-repo provenance). */
  gitRepo?: string
}

export interface CuratedFactUpsertInput {
  text: string
  sourceRef?: string
  evidence?: FactEvidenceKind
  gitRepo?: string
}

export interface FactRow {
  id: string
  git_repo: string | null
  text: string
  source_ref: string | null
  evidence: FactEvidenceKind
  tombstoned_at: string | null
  created_at: string
  updated_at: string
}

/** Whole markdown file as one indexed unit (`documents`). */
export interface DocumentIndexRow {
  id: string
  git_repo: string
  rel_path: string
  title: string
  body: string
  content_hash: string
  indexed_at: string
}

export interface DocumentIndexUpsertInput {
  gitRepo?: string
  relPath: string
  title: string
  body: string
  contentHash?: string
}

/** One exported AST symbol with its source text (`code_symbols`). */
export interface CodeSymbolRow {
  id: string
  git_repo: string
  rel_path: string
  name: string
  kind: string
  source_text: string | null
  content_hash: string
  indexed_at: string
}

export interface CodeSymbolUpsertInput {
  gitRepo?: string
  relPath: string
  name: string
  kind: string
  sourceText?: string
  contentHash?: string
}

export interface DocCodeLinkInput {
  symbolId: string
  score?: number
  linkKind?: string
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
  'id, git_repo, text, source_ref, evidence, tombstoned_at, created_at, updated_at'

const FACT_ROW_SELECT_F =
  'f.id, f.git_repo, f.text, f.source_ref, f.evidence, f.tombstoned_at, f.created_at, f.updated_at'

/** `documents` row projection — keep aligned with `DocumentIndexRow`. */
const DOCUMENT_ROW_SELECT =
  'id, git_repo, rel_path, title, body, content_hash, indexed_at'

/** `code_symbols` row projection — keep aligned with `CodeSymbolRow`. */
const CODE_SYMBOL_ROW_SELECT =
  'id, git_repo, rel_path, name, kind, source_text, content_hash, indexed_at'

const CODE_SYMBOL_ROW_SELECT_S =
  's.id, s.git_repo, s.rel_path, s.name, s.kind, s.source_text, s.content_hash, s.indexed_at'

/** Documents over this size are stored whole but truncated when served as retrieval content. */
export const DOCUMENT_CONTENT_MAX_CHARS = 20_000

const DOCUMENT_EMBED_MAX_CHARS = 4_000
const SYMBOL_EMBED_MAX_CHARS = 2_000

/**
 * True when a base has no retrievable content — the index file is absent, or it exists but
 * holds zero documents, code symbols, and facts. Used to give an "this base is empty" answer
 * instead of running retrieval that can only come up empty. A missing file is not created
 * (guarded by `existsSync`); an unreadable/unmigrated index counts as empty.
 */
export function isKbIndexEmpty(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath)
    const row = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM documents) + (SELECT COUNT(*) FROM code_symbols) + (SELECT COUNT(*) FROM facts) AS n'
      )
      .get() as { n: number } | undefined
    return (row?.n ?? 0) === 0
  } catch {
    return true
  } finally {
    db?.close()
  }
}

export class SqliteKbIndexer {
  private readonly db: DatabaseSync
  private readonly modelId: string
  private readonly vectorDimensions: number
  private transactionDepth = 0
  /** Repo slug applied to facts that don't set one explicitly (multi-repo provenance). */
  private activeGitRepo: string | null = null
  /** Optional real embedder. When set, semantic scoring uses real vectors over the hash proxy. */
  private embedder: Embedder | null = null
  /** Cache of real query vectors keyed by query string (one embed call per distinct query). */
  private readonly queryVectorCache = new Map<string, number[]>()

  constructor(options: SqliteKbIndexerOptions) {
    this.db = new DatabaseSync(options.dbPath)
    this.modelId = options.modelId ?? process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text'
    this.vectorDimensions = options.vectorDimensions ?? 64
    this.embedder = options.embedder ?? null
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    runMigrations(this.db)
  }

  /** Attach a real embedder for semantic scoring + ingest re-embedding. */
  setEmbedder(embedder: Embedder | null): void {
    this.embedder = embedder
  }

  /**
   * Pre-compute and cache the real embedding for a query string. Call once before a retrieval
   * loop so the per-iteration {@link semanticFactScores} calls can score against a real query
   * vector without re-embedding. No-op (and safe) when no embedder is attached.
   */
  async cacheQueryEmbedding(query: string): Promise<void> {
    const q = query.trim()
    if (!this.embedder || !q || this.queryVectorCache.has(q)) return
    try {
      const [vector] = await this.embedder.embed([q])
      if (vector && vector.length === this.embedder.dimensions) this.queryVectorCache.set(q, vector)
    } catch {
      // Embedding is best-effort; fall back to the deterministic vector on any failure.
    }
  }

  /**
   * (Re-)embed every row of one indexed table whose stored embedding was not produced by the
   * attached embedder. Idempotent: rows already carrying the current `modelId` are skipped.
   *
   * Bounded-memory pagination (issue #191): keyset-paginate by row id instead of loading every
   * stale row into one array up front, so peak memory is O(fetchPageSize) rather than O(rows) —
   * a cold index of a large repo used to OOM here even though `embed()` was already batched.
   */
  private async embedTable(
    spec: {
      table: string
      embeddingTable: string
      idColumn: string
      textSql: string
      liveFilter?: string
    },
    onProgress?: (done: number, total: number) => void,
    batchSize = 100,
    fetchPageSize: number = resolveEmbedFetchPageSize()
  ): Promise<number> {
    if (!this.embedder) return 0
    const embedder = this.embedder
    const live = spec.liveFilter ? `${spec.liveFilter} AND ` : ''
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM ${spec.table} t
           LEFT JOIN ${spec.embeddingTable} e ON e.${spec.idColumn} = t.id
           WHERE ${live}(e.model_id IS NULL OR e.model_id != ?)`
        )
        .get(embedder.modelId) as { c: number }
    ).c
    if (total === 0) return 0

    const selectPage = this.db.prepare(
      `SELECT t.id AS id, ${spec.textSql} AS text
       FROM ${spec.table} t
       LEFT JOIN ${spec.embeddingTable} e ON e.${spec.idColumn} = t.id
       WHERE ${live}(e.model_id IS NULL OR e.model_id != ?) AND t.id > ?
       ORDER BY t.id
       LIMIT ?`
    )
    const now = dayjs().toISOString()
    const upsert = this.db.prepare(
      `INSERT INTO ${spec.embeddingTable} (${spec.idColumn}, model_id, dimensions, vector_json, embedded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(${spec.idColumn}) DO UPDATE SET
         model_id = excluded.model_id, dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, embedded_at = excluded.embedded_at`
    )

    let done = 0
    let cursor = ''
    while (true) {
      const page = selectPage.all(embedder.modelId, cursor, fetchPageSize) as Array<{
        id: string
        text: string | null
      }>
      if (page.length === 0) break
      for (let i = 0; i < page.length; i += batchSize) {
        const batch = page.slice(i, i + batchSize)
        const vectors = await embedder.embed(batch.map(r => r.text ?? ''))
        for (let j = 0; j < batch.length; j++) {
          const vec = vectors[j]
          if (!vec || vec.length !== embedder.dimensions) continue
          upsert.run(batch[j].id, embedder.modelId, embedder.dimensions, JSON.stringify(vec), now)
        }
      }
      done += page.length
      cursor = page[page.length - 1].id
      onProgress?.(Math.min(done, total), total)
    }
    return done
  }

  /** (Re-)embed every curated fact. No-op when no embedder is attached. */
  async embedAllFacts(
    onProgress?: (done: number, total: number) => void,
    batchSize = 100,
    fetchPageSize: number = resolveEmbedFetchPageSize()
  ): Promise<number> {
    return this.embedTable(
      {
        table: 'facts',
        embeddingTable: 'fact_embeddings',
        idColumn: 'fact_id',
        textSql: 't.text',
        liveFilter: 't.tombstoned_at IS NULL',
      },
      onProgress,
      batchSize,
      fetchPageSize
    )
  }

  /** (Re-)embed every indexed document (title + body). No-op when no embedder is attached. */
  async embedAllDocuments(
    onProgress?: (done: number, total: number) => void,
    batchSize = 100,
    fetchPageSize: number = resolveEmbedFetchPageSize()
  ): Promise<number> {
    return this.embedTable(
      {
        table: 'documents',
        embeddingTable: 'doc_embeddings',
        idColumn: 'doc_id',
        // Embedders truncate at their own context window; sending the whole body of a huge
        // file wastes the request, so the vector is built from the title + document head.
        textSql: `t.title || char(10) || substr(t.body, 1, ${DOCUMENT_EMBED_MAX_CHARS})`,
      },
      onProgress,
      batchSize,
      fetchPageSize
    )
  }

  /** (Re-)embed every code symbol (name + source text). No-op when no embedder is attached. */
  async embedAllCodeSymbols(
    onProgress?: (done: number, total: number) => void,
    batchSize = 100,
    fetchPageSize: number = resolveEmbedFetchPageSize()
  ): Promise<number> {
    return this.embedTable(
      {
        table: 'code_symbols',
        embeddingTable: 'code_embeddings',
        idColumn: 'symbol_id',
        textSql: `t.name || ' ' || t.kind || ' ' || t.rel_path || char(10) || substr(COALESCE(t.source_text, ''), 1, ${SYMBOL_EMBED_MAX_CHARS})`,
      },
      onProgress,
      batchSize,
      fetchPageSize
    )
  }

  /**
   * Set the repo slug stamped onto facts that don't pass `gitRepo` explicitly. Lets the code
   * indexers tag every fact for the repo being scanned without threading the slug through
   * every `upsertCodeFileFact` call. Pass `null` to clear.
   */
  setActiveGitRepo(slug: string | null): void {
    this.activeGitRepo = slug
  }

  async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) return await fn()
    this.db.exec('BEGIN')
    this.transactionDepth = 1
    try {
      const result = await fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth = 0
    }
  }

  /**
   * Upsert a curated fact. `facts` holds only deliberate assertions now — the sentence-level
   * derived store is gone — so text is deduped on its normalized form within a repo.
   */
  upsertCuratedFact(input: CuratedFactUpsertInput): {
    id: string
    operation: 'inserted' | 'updated'
  } {
    const now = dayjs().toISOString()
    const gitRepo = input.gitRepo ?? this.activeGitRepo
    const text = input.text.trim()
    const normalized = normalizeFactText(text)
    if (!normalized) throw new Error('upsertCuratedFact: text is required')
    const evidence = input.evidence ?? DEFAULT_FACT_EVIDENCE
    // Deterministic id from the normalized text: re-asserting the same fact updates one row
    // instead of needing a separate normalized_text column to dedupe against.
    const id = factIdFromText(normalized)

    const existing = this.db.prepare('SELECT id FROM facts WHERE id = ?').get(id) as
      | { id: string }
      | undefined

    if (existing) {
      this.db
        .prepare(
          `UPDATE facts
           SET text = ?, source_ref = ?, evidence = ?, tombstoned_at = NULL, updated_at = ?,
               git_repo = COALESCE(?, git_repo)
           WHERE id = ?`
        )
        .run(text, input.sourceRef ?? null, evidence, now, gitRepo, id)
      this.rebuildFactIndexes(id, text, now)
      return { id, operation: 'updated' }
    }

    this.db
      .prepare(
        `INSERT INTO facts (id, git_repo, text, source_ref, evidence, tombstoned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, gitRepo, text, input.sourceRef ?? null, evidence, now, now)
    this.rebuildFactIndexes(id, text, now)
    return { id, operation: 'inserted' }
  }

  /**
   * Compatibility shim for callers still on the pre-v21 triplet write shape. Triplets and
   * source kinds are no longer stored — the write lands as a curated fact.
   */
  upsertFact(input: FactUpsertInput): { id: string; operation: 'inserted' | 'updated' } {
    return this.upsertCuratedFact({
      text: input.factText,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.gitRepo ? { gitRepo: input.gitRepo } : {}),
    })
  }

  /** Resolve a fact by normalized lowercase + collapsed whitespace match. */
  getActiveFactByTextMatch(factText: string): FactRow | undefined {
    const id = factIdFromText(normalizeFactText(factText))
    return this.getActiveFactById(id)
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
      .all(limit) as unknown as FactRow[]
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
            AND f.tombstoned_at IS NULL
          ORDER BY rank
          LIMIT ?
        `
        )
        .all(ftsQuery, limit) as unknown as FactRow[]
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
          WHERE tombstoned_at IS NULL AND lower(text) LIKE ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
        )
        .all(like, limit) as unknown as FactRow[]
    }

    const where = tokens.map(() => 'lower(text) LIKE ?').join(' OR ')
    const likeValues = tokens.map(token => `%${token}%`)
    return this.db
      .prepare(
        `
        SELECT ${FACT_ROW_SELECT}
        FROM facts
        WHERE tombstoned_at IS NULL AND (${where})
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(...likeValues, limit) as unknown as FactRow[]
  }

  semanticFactScores(query: string, factIds: string[]): Map<string, number> {
    return this.semanticScores('fact_embeddings', 'fact_id', query, factIds)
  }

  semanticDocumentScores(query: string, docIds: string[]): Map<string, number> {
    return this.semanticScores('doc_embeddings', 'doc_id', query, docIds)
  }

  semanticCodeSymbolScores(query: string, symbolIds: string[]): Map<string, number> {
    return this.semanticScores('code_embeddings', 'symbol_id', query, symbolIds)
  }

  /**
   * Cosine similarity of the query against stored vectors, rescaled to [0, 1]. Uses the real
   * query vector when the query was pre-embedded by {@link cacheQueryEmbedding} *and* the row
   * came from the same model; anything else falls back to the deterministic hash vector.
   */
  private semanticScores(
    table: string,
    idColumn: string,
    query: string,
    ids: string[]
  ): Map<string, number> {
    const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))]
    const out = new Map<string, number>()
    if (!query.trim() || unique.length === 0) return out
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT ${idColumn} AS id, vector_json, dimensions, model_id
         FROM ${table}
         WHERE ${idColumn} IN (${placeholders})`
      )
      .all(...unique) as Array<{
      id: string
      vector_json?: string
      dimensions?: number
      model_id?: string
    }>
    const realQueryVec = this.embedder ? this.queryVectorCache.get(query.trim()) : undefined
    for (const row of rows) {
      if (!row.vector_json || !row.dimensions) continue
      try {
        const stored = JSON.parse(row.vector_json) as number[]
        if (!Array.isArray(stored) || stored.length !== row.dimensions) continue
        const useReal =
          realQueryVec &&
          this.embedder &&
          row.model_id === this.embedder.modelId &&
          realQueryVec.length === row.dimensions
        const queryVec = useReal ? realQueryVec : buildDeterministicVector(query, row.dimensions)
        out.set(row.id, (cosineSimilarity(queryVec, stored) + 1) / 2)
      } catch {
        // ignore malformed embedding rows
      }
    }
    return out
  }

  invalidateFact(
    oldFact: string,
    replacement?: { factText: string }
  ): { changed: number; replacementId?: string } {
    const id = factIdFromText(normalizeFactText(oldFact))
    if (!this.tombstoneFactById(id)) return { changed: 0 }

    if (!replacement?.factText?.trim()) {
      return { changed: 1 }
    }

    const replaced = this.upsertCuratedFact({
      text: replacement.factText,
      sourceRef: `replace:${id}`,
    })
    return { changed: 1, replacementId: replaced.id }
  }

  /** Delete a fact row by id and clear all derived indexes. Returns true if a row was changed. */
  tombstoneFactById(factId: string): boolean {
    const row = this.db.prepare('SELECT id FROM facts WHERE id = ?').get(factId) as
      | { id: string }
      | undefined
    if (!row) return false
    // fact_embeddings cascades on the facts FK; facts_fts is virtual and cleared explicitly.
    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(row.id)
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(row.id)
    return true
  }

  /** Active facts whose `source_ref` exactly matches `sourceRef`. */
  listFactsBySourceRef(sourceRef: string): FactRow[] {
    return this.db
      .prepare(
        `SELECT ${FACT_ROW_SELECT} FROM facts WHERE source_ref = ?`
      )
      .all(sourceRef) as unknown as FactRow[]
  }

  /** Active facts whose `source_ref` starts with `prefix` (e.g. `code:src/foo.ts@`). */
  listActiveFactsBySourceRefPrefix(prefix: string): FactRow[] {
    return this.db
      .prepare(
        `SELECT ${FACT_ROW_SELECT} FROM facts WHERE source_ref LIKE ?`
      )
      .all(`${prefix}%`) as unknown as FactRow[]
  }

  /**
   * Hard-delete every fact tagged with `gitRepo` (and its derived index rows), so a repo
   * dropped from a base leaves no facts behind. Returns the count.
   */
  deleteFactsByRepo(gitRepo: string): number {
    const rows = this.db
      .prepare('SELECT id FROM facts WHERE git_repo = ?')
      .all(gitRepo) as Array<{ id: string }>
    if (rows.length === 0) return 0
    const delFts = this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?')
    for (const { id } of rows) delFts.run(id)
    // fact_embeddings cascades on the facts FK; facts_fts is virtual and cleared above.
    this.db.prepare('DELETE FROM facts WHERE git_repo = ?').run(gitRepo)
    return rows.length
  }

  // ─── Documents (whole markdown files) ────────────────────────────

  /**
   * Upsert one markdown file as a single indexed document. The FTS row is deleted and
   * re-inserted rather than updated — `documents_fts` is a contentless-style external index
   * keyed by `doc_id`, so an UPDATE would leave the old tokenization behind.
   */
  upsertDocument(input: DocumentIndexUpsertInput): { id: string; operation: 'inserted' | 'updated' } {
    const now = dayjs().toISOString()
    const gitRepo = input.gitRepo ?? this.activeGitRepo ?? ''
    const relPath = input.relPath.replace(/\\/g, '/')
    const id = documentId(gitRepo, relPath)
    const contentHash = input.contentHash ?? sha256(input.body)
    const existing = this.db
      .prepare('SELECT content_hash, title FROM documents WHERE id = ?')
      .get(id) as { content_hash: string; title: string } | undefined
    // Same repo+path id, so an existing row means an update. The embedding text is
    // title + body head, so a change to either must invalidate the stored vector.
    const changed =
      !existing || existing.content_hash !== contentHash || existing.title !== input.title

    this.db
      .prepare(
        `INSERT INTO documents (id, git_repo, rel_path, title, body, content_hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at`
      )
      .run(id, gitRepo, relPath, input.title, input.body, contentHash, now)

    if (changed) {
      // Re-tokenize FTS and drop the now-stale neural vector so the embed backfill
      // regenerates it — `embedTable` only re-embeds missing/other-model rows, never a
      // same-model row whose content changed, so without this the vector would go stale.
      this.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(id)
      this.db
        .prepare('INSERT INTO documents_fts (doc_id, body) VALUES (?, ?)')
        .run(id, `${input.title}\n${input.body}`)
      if (existing) this.db.prepare('DELETE FROM doc_embeddings WHERE doc_id = ?').run(id)
    }

    return { id, operation: existing ? 'updated' : 'inserted' }
  }

  /**
   * True when an indexed document already matches this exact content (same body hash and
   * title), so a re-scan can skip the row rewrite, FTS re-tokenize, embedding, and link
   * recompute — the document counterpart of the code indexer's content-hash short-circuit.
   */
  documentUnchanged(gitRepo: string, relPath: string, body: string, title: string): boolean {
    const repo = gitRepo || this.activeGitRepo || ''
    const existing = this.getDocumentByPath(repo, relPath)
    return Boolean(existing && existing.content_hash === sha256(body) && existing.title === title)
  }

  deleteDocument(id: string): boolean {
    const row = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(id) as
      | { id: string }
      | undefined
    if (!row) return false
    this.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    return true
  }

  getDocument(id: string): DocumentIndexRow | undefined {
    return this.db
      .prepare(`SELECT ${DOCUMENT_ROW_SELECT} FROM documents WHERE id = ?`)
      .get(id) as DocumentIndexRow | undefined
  }

  getDocumentByPath(gitRepo: string, relPath: string): DocumentIndexRow | undefined {
    return this.db
      .prepare(`SELECT ${DOCUMENT_ROW_SELECT} FROM documents WHERE git_repo = ? AND rel_path = ?`)
      .get(gitRepo, relPath.replace(/\\/g, '/')) as DocumentIndexRow | undefined
  }

  listDocumentsByRepo(gitRepo: string): DocumentIndexRow[] {
    return this.db
      .prepare(
        `SELECT ${DOCUMENT_ROW_SELECT} FROM documents WHERE git_repo = ? ORDER BY rel_path`
      )
      .all(gitRepo) as unknown as DocumentIndexRow[]
  }

  /** Path index for a repo without loading document bodies — used for stale-file reconciliation. */
  listDocumentPathsByRepo(gitRepo: string): Array<{ id: string; rel_path: string }> {
    return this.db
      .prepare('SELECT id, rel_path FROM documents WHERE git_repo = ? ORDER BY rel_path')
      .all(gitRepo) as Array<{ id: string; rel_path: string }>
  }

  searchDocumentsFts(query: string, limit = 20): DocumentIndexRow[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return []
    try {
      return this.db
        .prepare(
          `SELECT d.id, d.git_repo, d.rel_path, d.title, d.body, d.content_hash, d.indexed_at
           FROM documents_fts fts
           JOIN documents d ON d.id = fts.doc_id
           WHERE documents_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, limit) as unknown as DocumentIndexRow[]
    } catch {
      return []
    }
  }

  // ─── Code symbols (AST exports) ──────────────────────────────────

  upsertCodeSymbol(input: CodeSymbolUpsertInput): {
    id: string
    operation: 'inserted' | 'updated'
  } {
    const now = dayjs().toISOString()
    const gitRepo = input.gitRepo ?? this.activeGitRepo ?? ''
    const relPath = input.relPath.replace(/\\/g, '/')
    const id = codeSymbolId(gitRepo, relPath, input.name)
    const contentHash = input.contentHash ?? sha256(input.sourceText ?? input.name)
    const existing = this.db.prepare('SELECT id FROM code_symbols WHERE id = ?').get(id) as
      | { id: string }
      | undefined

    this.db
      .prepare(
        `INSERT INTO code_symbols (id, git_repo, rel_path, name, kind, source_text, content_hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           source_text = excluded.source_text,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at`
      )
      .run(id, gitRepo, relPath, input.name, input.kind, input.sourceText ?? null, contentHash, now)

    this.db.prepare('DELETE FROM code_symbols_fts WHERE symbol_id = ?').run(id)
    this.db
      .prepare('INSERT INTO code_symbols_fts (symbol_id, name, source_text) VALUES (?, ?, ?)')
      .run(id, `${input.name} ${relPath}`, input.sourceText ?? '')

    return { id, operation: existing ? 'updated' : 'inserted' }
  }

  /** Drop every symbol recorded for one file — call before re-extracting it. */
  deleteCodeSymbolsForFile(gitRepo: string, relPath: string): number {
    const normalized = relPath.replace(/\\/g, '/')
    const rows = this.db
      .prepare('SELECT id FROM code_symbols WHERE git_repo = ? AND rel_path = ?')
      .all(gitRepo, normalized) as Array<{ id: string }>
    if (rows.length === 0) return 0
    const delFts = this.db.prepare('DELETE FROM code_symbols_fts WHERE symbol_id = ?')
    for (const { id } of rows) delFts.run(id)
    this.db
      .prepare('DELETE FROM code_symbols WHERE git_repo = ? AND rel_path = ?')
      .run(gitRepo, normalized)
    return rows.length
  }

  getCodeSymbol(id: string): CodeSymbolRow | undefined {
    return this.db
      .prepare(`SELECT ${CODE_SYMBOL_ROW_SELECT} FROM code_symbols WHERE id = ?`)
      .get(id) as CodeSymbolRow | undefined
  }

  /** Symbols under a file or directory prefix, e.g. `src/core/` or `src/core/init.ts`. */
  listCodeSymbolsByPathPrefix(prefix: string, gitRepo?: string): CodeSymbolRow[] {
    const normalized = prefix.replace(/\\/g, '/')
    if (gitRepo === undefined) {
      return this.db
        .prepare(
          `SELECT ${CODE_SYMBOL_ROW_SELECT} FROM code_symbols WHERE rel_path LIKE ? ORDER BY rel_path, name`
        )
        .all(`${normalized}%`) as unknown as CodeSymbolRow[]
    }
    return this.db
      .prepare(
        `SELECT ${CODE_SYMBOL_ROW_SELECT} FROM code_symbols
         WHERE git_repo = ? AND rel_path LIKE ? ORDER BY rel_path, name`
      )
      .all(gitRepo, `${normalized}%`) as unknown as CodeSymbolRow[]
  }

  /** Symbol identity for a repo, without source text — used for stale-file reconciliation. */
  listCodeSymbolKeysByRepo(
    gitRepo: string
  ): Array<{ id: string; rel_path: string; name: string }> {
    return this.db
      .prepare('SELECT id, rel_path, name FROM code_symbols WHERE git_repo = ?')
      .all(gitRepo) as Array<{ id: string; rel_path: string; name: string }>
  }

  deleteCodeSymbol(id: string): boolean {
    const row = this.db.prepare('SELECT id FROM code_symbols WHERE id = ?').get(id) as
      | { id: string }
      | undefined
    if (!row) return false
    this.db.prepare('DELETE FROM code_symbols_fts WHERE symbol_id = ?').run(id)
    this.db.prepare('DELETE FROM code_symbols WHERE id = ?').run(id)
    return true
  }

  searchCodeSymbolsFts(query: string, limit = 20): CodeSymbolRow[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return []
    try {
      return this.db
        .prepare(
          `SELECT ${CODE_SYMBOL_ROW_SELECT_S}
           FROM code_symbols_fts fts
           JOIN code_symbols s ON s.id = fts.symbol_id
           WHERE code_symbols_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, limit) as unknown as CodeSymbolRow[]
    } catch {
      return []
    }
  }

  // ─── doc ↔ symbol links (flat, not a graph) ──────────────────────

  /** Replace every link for one document. Unknown symbol ids are skipped (FK would reject). */
  replaceDocCodeLinks(docId: string, links: DocCodeLinkInput[]): number {
    this.db.prepare('DELETE FROM doc_code_links WHERE doc_id = ?').run(docId)
    if (links.length === 0) return 0
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO doc_code_links (doc_id, symbol_id, score, link_kind)
       VALUES (?, ?, ?, ?)`
    )
    let written = 0
    for (const link of links) {
      if (!link.symbolId) continue
      try {
        insert.run(docId, link.symbolId, link.score ?? 1.0, link.linkKind ?? 'relates_to')
        written += 1
      } catch {
        // Symbol disappeared between scoring and write — the link is simply not recorded.
      }
    }
    return written
  }

  listLinkedSymbols(docId: string, limit = 20): Array<CodeSymbolRow & { link_score: number }> {
    return this.db
      .prepare(
        `SELECT ${CODE_SYMBOL_ROW_SELECT_S}, l.score AS link_score
         FROM doc_code_links l
         JOIN code_symbols s ON s.id = l.symbol_id
         WHERE l.doc_id = ?
         ORDER BY l.score DESC
         LIMIT ?`
      )
      .all(docId, limit) as unknown as Array<CodeSymbolRow & { link_score: number }>
  }

  listLinkingDocuments(
    symbolId: string,
    limit = 20
  ): Array<DocumentIndexRow & { link_score: number }> {
    return this.db
      .prepare(
        `SELECT d.id, d.git_repo, d.rel_path, d.title, d.body, d.content_hash, d.indexed_at,
                l.score AS link_score
         FROM doc_code_links l
         JOIN documents d ON d.id = l.doc_id
         WHERE l.symbol_id = ?
         ORDER BY l.score DESC
         LIMIT ?`
      )
      .all(symbolId, limit) as unknown as Array<DocumentIndexRow & { link_score: number }>
  }

  /** Indexed-unit counts grouped by originating git repo (NULL/'' → '(unscoped)'). */
  listRepoStats(): Array<{ repo: string; count: number }> {
    return this.db
      .prepare(
        `SELECT repo, SUM(count) AS count FROM (
           SELECT COALESCE(NULLIF(git_repo, ''), '(unscoped)') AS repo, COUNT(*) AS count
           FROM documents GROUP BY 1
           UNION ALL
           SELECT COALESCE(NULLIF(git_repo, ''), '(unscoped)') AS repo, COUNT(*) AS count
           FROM code_symbols GROUP BY 1
           UNION ALL
           SELECT COALESCE(NULLIF(git_repo, ''), '(unscoped)') AS repo, COUNT(*) AS count
           FROM facts WHERE tombstoned_at IS NULL GROUP BY 1
         )
         GROUP BY repo
         ORDER BY count DESC, repo ASC`
      )
      .all() as Array<{ repo: string; count: number }>
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
        ? (this.db.prepare(derivedQuery).all(limit) as unknown as SqliteDocumentRow[])
        : (this.db.prepare(derivedQuery).all() as unknown as SqliteDocumentRow[])
    const original =
      typeof limit === 'number'
        ? (this.db.prepare(originalQuery).all(limit) as unknown as SqliteDocumentRow[])
        : (this.db.prepare(originalQuery).all() as unknown as SqliteDocumentRow[])
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
      .all() as unknown as SqliteDocumentRow[]
    const original = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
      `
      )
      .all() as unknown as SqliteDocumentRow[]
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
      .all() as unknown as SqliteDocumentRow[]
    const original = this.db
      .prepare(
        `
        SELECT id, title, markdown AS content, source_ref AS file_path, doc_type, NULL AS lane, tags_json, created_at, updated_at, 1 AS is_original
        FROM original_docs
        ORDER BY updated_at DESC
      `
      )
      .all() as unknown as SqliteDocumentRow[]
    return [...derived, ...original].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  private rebuildFactIndexes(factId: string, factText: string, now: string): void {
    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(factId)
    this.db.prepare('INSERT INTO facts_fts (fact_id, text) VALUES (?, ?)').run(factId, factText)

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

    runInTransaction(this.db, () => {
      deleteDerived.run(documentId)
      deleteOriginal.run(documentId)
      upsertIndexState.run({ value: now, updatedAt: now })
    })
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

    runInTransaction(this.db, () => {
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
      .all(limit) as unknown as RetrievalMissCluster[]

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
      .all(queryFingerprint, minOccurrences) as unknown as RetrievalRankingHint[]

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
        evidence,
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
        @evidence,
        @method,
        @detail,
        @surface,
        @createdAt
      )
    `)

    const now = dayjs().toISOString()
    runInTransaction(this.db, () => {
      for (const event of events) {
        insertCheckpoint.run({
          queryFingerprint: event.queryFingerprint,
          stage: event.stage,
          status: event.status,
          nextAction: event.nextAction,
          evidence: event.evidence,
          method: event.method,
          detail: event.detail ?? null,
          surface: event.surface,
          createdAt: now,
        })
      }
    })
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
        evidence,
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
        @evidence,
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
        evidence: input.evidence,
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
      // Prefer a real workspace path for source_ref. Using the document id
      // (sanitizeId of the path → `src-core-init-md`) made citations unopenable.
      // Title is often the path for filesystem-imported companions.
      const titleAsPath = input.title?.trim().replace(/\\/g, '/')
      const sourceRef =
        titleAsPath && isOpenableSourcePath(titleAsPath) ? titleAsPath : input.id
      this.upsertOriginalDoc({
        id: input.id,
        title: input.title,
        markdown: input.content,
        sourceRef,
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

/** Exported for tools that must resolve a curated fact by its text. */
export function normalizeFactText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Curated facts are keyed by their normalized text, so re-asserting one updates in place. */
function factIdFromText(normalized: string): string {
  return `fact-${sha256(normalized).slice(0, 16)}`
}

export function documentId(gitRepo: string, relPath: string): string {
  return `doc-${sha256(`${gitRepo}:${relPath}`).slice(0, 16)}`
}

export function codeSymbolId(gitRepo: string, relPath: string, name: string): string {
  return `sym-${sha256(`${gitRepo}:${relPath}:${name}`).slice(0, 16)}`
}

/**
 * FTS5 OR-query from free text. Also emits the camelCase-joined form, so "agent loop"
 * matches the single token "agentloop" stored for a symbol named `agentLoop`.
 */
export function buildFtsQuery(input: string): string {
  const tokens = tokenizeQuery(input)
  if (tokens.length === 0) return ''
  const joined = tokens.join('')
  const terms =
    joined.length > 2 && joined !== tokens.join(' ') ? [...new Set([...tokens, joined])] : tokens
  return terms.join(' OR ')
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

