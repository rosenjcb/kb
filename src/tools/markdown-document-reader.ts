/**
 * Document reader for querying markdown-based KB
 * See: Ticket 008 - Query Documents Tool Contract
 */

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import dayjs from 'dayjs'
import Database from 'better-sqlite3'
import {
  buildCheckpointRecord,
  type RetrievalCheckpointRecord,
} from './retrieval-checkpoint-orchestrator'

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'of', 'on', 'or', 'our', 'that', 'the', 'this', 'to',
  'was', 'we', 'what', 'when', 'where', 'who', 'why', 'with', 'you', 'your',
])

export interface QueryDocumentsInput {
  query?: string
  mode?: 'id' | 'title' | 'tags' | 'content'
  tags?: string[]
  type?: 'architecture' | 'decision' | 'checklist' | 'runbook' | 'reference'
  limit?: number
  includeContent?: boolean
}

export interface DocumentMetadata {
  id: string
  title: string
  filePath: string
  createdAt: string
  updatedAt: string
  tags?: string[]
  type?: QueryDocumentsInput['type']
}

export interface QueryResult {
  metadata: DocumentMetadata
  content?: string
}

export interface QueryResponse {
  results: QueryResult[]
  total: number
  retrieval: {
    method: 'hybrid' | 'lexical' | 'lexical-fallback'
    detail?: string
    checkpoints?: RetrievalCheckpointRecord[]
  }
}

export interface MarkdownDocumentReaderOptions {
  hybridEnabled?: boolean
  sqliteDbPath?: string
  hybridCandidateLimit?: number
  hybridAlpha?: number
  hybridMaxMs?: number
  missLearningEnabled?: boolean
  rankingHintsEnabled?: boolean
  rankingHintMinOccurrences?: number
  checkpointObservabilityEnabled?: boolean
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token))
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim()
}

function tokenOverlapCount(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return 0

  const contentTokens = new Set(tokenize(content))
  let overlapCount = 0
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlapCount += 1
    }
  }

  return overlapCount
}

function contentMatchScore(query: string, content: string): number {
  const normalizedQuery = normalizeText(query)
  const normalizedContent = normalizeText(content)
  const queryTokens = tokenize(query)
  const overlapCount = tokenOverlapCount(query, content)
  const overlapRatio = queryTokens.length > 0 ? overlapCount / queryTokens.length : 0

  if (!normalizedQuery) return 0

  if (normalizedContent.includes(normalizedQuery)) {
    return 70 + overlapRatio * 25
  }

  if (overlapCount > 0) {
    return 40 + overlapRatio * 35
  }

  return 0
}

interface MatchEvaluation {
  matched: boolean
  score: number
}

/**
 * Parses document metadata from markdown file
 */
function parseDocumentMetadata(filePath: string, content: string): DocumentMetadata | null {
  const lines = content.split('\n')
  
  // First line must be H1 (title)
  if (!lines[0].startsWith('# ')) {
    return null
  }
  
  const title = lines[0].replace(/^# /, '').trim()
  const id = path.basename(filePath, '.md')
  
  // Parse Created timestamp (should be in first few lines)
  let createdAt = dayjs().toISOString()
  let updatedAt = dayjs().toISOString()
  let tags: string[] | undefined
  let type: QueryDocumentsInput['type']
  
  for (let i = 1; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim()
    if (line.startsWith('Created:')) {
      createdAt = line.replace('Created:', '').trim()
    }
    if (line.startsWith('Tags:')) {
      const tagsStr = line.replace('Tags:', '').trim()
      tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean)
    }
    if (line.startsWith('Type:')) {
      const parsedType = line.replace('Type:', '').trim()
      if (['architecture', 'decision', 'checklist', 'runbook', 'reference'].includes(parsedType)) {
        type = parsedType as QueryDocumentsInput['type']
      }
    }
  }
  
  return {
    id,
    title,
    filePath,
    createdAt,
    updatedAt,
    tags,
    type,
  }
}

export class MarkdownDocumentReader {
  private readonly hybridEnabled: boolean
  private readonly sqliteDbPath: string
  private readonly hybridCandidateLimit: number
  private readonly hybridAlpha: number
  private readonly hybridMaxMs: number
  private readonly missLearningEnabled: boolean
  private readonly rankingHintsEnabled: boolean
  private readonly rankingHintMinOccurrences: number
  private readonly checkpointObservabilityEnabled: boolean

  constructor(
    private baseDir: string,
    options: MarkdownDocumentReaderOptions = {},
  ) {
    this.hybridEnabled = options.hybridEnabled ?? process.env.KB_HYBRID_QUERY === 'true'
    this.sqliteDbPath = options.sqliteDbPath ?? path.join(baseDir, '.kb-index.sqlite')
    this.hybridCandidateLimit = options.hybridCandidateLimit ?? parsePositiveInt(process.env.KB_HYBRID_QUERY_CANDIDATES, 40)
    this.hybridAlpha = options.hybridAlpha ?? parseBoundedNumber(process.env.KB_HYBRID_QUERY_ALPHA, 0.45)
    this.hybridMaxMs = options.hybridMaxMs ?? parsePositiveInt(process.env.KB_HYBRID_QUERY_MAX_MS, 120)
    this.missLearningEnabled = options.missLearningEnabled ?? process.env.KB_MISS_LEARNING_ENABLED === 'true'
    this.rankingHintsEnabled = options.rankingHintsEnabled ?? process.env.KB_MISS_HINTS_ENABLED === 'true'
    this.rankingHintMinOccurrences = options.rankingHintMinOccurrences
      ?? parsePositiveInt(process.env.KB_MISS_HINT_MIN_OCCURRENCES, 3)
    this.checkpointObservabilityEnabled = options.checkpointObservabilityEnabled
      ?? process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED !== 'false'
  }

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    const checkpoints: RetrievalCheckpointRecord[] = []

    if (this.shouldUseHybrid(input)) {
      const hybridAttempt = await this.tryHybridQuery(input)
      if (hybridAttempt.response) {
        const hybridResponse: QueryResponse = {
          ...hybridAttempt.response,
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
          },
        }

        checkpoints.push(buildCheckpointRecord({
          stage: 'hybrid_primary',
          totalResults: hybridResponse.total,
          method: hybridResponse.retrieval.method,
          detail: hybridResponse.retrieval.detail,
          reason: 'hybrid-stage-complete',
        }))

        if (checkpoints.at(-1)?.nextAction === 'return') {
          const response = withCheckpoints(hybridResponse, checkpoints)
          this.maybeRecordMissLearning(input, response)
          this.maybeRecordCheckpointEvents(input, response)
          return response
        }

        const response = await this.runLexicalCheckpointPipeline(
          input,
          {
            method: 'lexical-fallback',
            detail: 'hybrid-low-confidence',
          },
          checkpoints,
        )
        this.maybeRecordMissLearning(input, response)
        this.maybeRecordCheckpointEvents(input, response)
        return response
      }

      checkpoints.push(buildCheckpointRecord({
        stage: 'hybrid_primary',
        totalResults: 0,
        method: 'hybrid',
        detail: hybridAttempt.fallbackReason,
        reason: hybridAttempt.fallbackReason ?? 'hybrid-unavailable',
        status: 'error',
      }))

      const response = await this.runLexicalCheckpointPipeline(input, {
        method: 'lexical-fallback',
        detail: hybridAttempt.fallbackReason ?? 'hybrid-unavailable',
      }, checkpoints)
      this.maybeRecordMissLearning(input, response)
      this.maybeRecordCheckpointEvents(input, response)
      return response
    }

    const response = await this.runLexicalCheckpointPipeline(input, {
      method: 'lexical',
      detail: 'hybrid-not-attempted',
    }, checkpoints)
    this.maybeRecordMissLearning(input, response)
    this.maybeRecordCheckpointEvents(input, response)
    return response
  }

  private async runLexicalCheckpointPipeline(
    input: QueryDocumentsInput,
    retrieval: QueryResponse['retrieval'],
    checkpoints: RetrievalCheckpointRecord[],
  ): Promise<QueryResponse> {
    const primary = await this.queryDocumentsLexical(input, retrieval)
    checkpoints.push(buildCheckpointRecord({
      stage: 'lexical_recovery',
      totalResults: primary.total,
      method: primary.retrieval.method,
      detail: primary.retrieval.detail,
      reason: 'lexical-stage-complete',
    }))

    const lexicalDecision = checkpoints.at(-1)
    if (lexicalDecision?.nextAction === 'return') {
      return withCheckpoints(primary, checkpoints)
    }

    if (!this.shouldAttemptKeywordRecovery(input, primary.total)) {
      return withCheckpoints(primary, checkpoints)
    }

    const broadenedQuery = buildKeywordQuery(input.query ?? '')
    if (!broadenedQuery || broadenedQuery === normalizeText(input.query ?? '')) {
      return withCheckpoints(primary, checkpoints)
    }

    const retry = await this.queryDocumentsLexical(
      {
        ...input,
        query: broadenedQuery,
        mode: 'content',
      },
      {
        method: retrieval.method,
        detail: appendRetrievalDetail(retrieval.detail, 'keyword-broadened'),
      },
    )

    checkpoints.push(buildCheckpointRecord({
      stage: 'query_rewrite_retry',
      totalResults: retry.total,
      method: retry.retrieval.method,
      detail: retry.retrieval.detail,
      reason: 'keyword-broadened',
    }))

    return withCheckpoints(retry, checkpoints)
  }

  private async queryDocumentsLexical(
    input: QueryDocumentsInput,
    retrieval: QueryResponse['retrieval'],
  ): Promise<QueryResponse> {
    const limit = input.limit ?? 10
    const matches: Array<{ result: QueryResult; score: number }> = []

    try {
      const files = await readdir(this.baseDir)
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== '_table.md')

      for (const file of mdFiles) {
        const filePath = path.join(this.baseDir, file)
        const content = await readFile(filePath, 'utf8')
        const metadata = parseDocumentMetadata(filePath, content)

        if (!metadata) continue

        const matchesType = !input.type || metadata.type === input.type
        if (!matchesType) continue

        const evaluation = evaluateDocumentMatch(input, metadata, content)
        if (!evaluation.matched) continue

        matches.push({
          score: evaluation.score,
          result: {
            metadata,
            content: input.includeContent ? content : undefined,
          },
        })
      }
    } catch {
      // KB directory doesn't exist or is empty; return empty results
      return { results: [], total: 0, retrieval }
    }

    matches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }

      const aUpdated = dayjs(a.result.metadata.updatedAt).valueOf()
      const bUpdated = dayjs(b.result.metadata.updatedAt).valueOf()
      return bUpdated - aUpdated
    })

    const results = matches.slice(0, limit).map(match => match.result)

    return {
      results,
      total: matches.length,
      retrieval,
    }
  }

  private shouldAttemptKeywordRecovery(input: QueryDocumentsInput, total: number): boolean {
    if (total > 0) return false
    if (!input.query?.trim()) return false
    if (input.tags?.length) return false

    return input.mode === 'content' || input.mode === undefined
  }

  private shouldUseHybrid(input: QueryDocumentsInput): boolean {
    if (!this.hybridEnabled) return false
    if (!input.query?.trim()) return false
    if (input.tags?.length) return false

    return input.mode === 'content' || input.mode === undefined
  }

  private async tryHybridQuery(input: QueryDocumentsInput): Promise<{
    response?: QueryResponse
    fallbackReason?: string
  }> {
    if (this.hybridMaxMs <= 0) {
      return { fallbackReason: 'latency-budget-exceeded' }
    }

    const startTime = Date.now()

    try {
      const db = new Database(this.sqliteDbPath, { readonly: true })

      try {
        const query = input.query?.trim() ?? ''
        const queryTokens = tokenize(query)
        if (queryTokens.length === 0) {
          return { fallbackReason: 'query-tokenization-empty' }
        }

        const ftsExpression = queryTokens.join(' OR ')
        const candidateRows = db
          .prepare(`
            SELECT chunk_id, doc_id, bm25(chunks_fts) AS lexical_rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
            LIMIT ?
          `)
          .all(ftsExpression, this.hybridCandidateLimit) as Array<{
            chunk_id: string
            doc_id: string
            lexical_rank: number
          }>

        const hintBoosts = this.rankingHintsEnabled
          ? this.loadRankingHintBoosts(db, query)
          : new Map<string, number>()

        if (candidateRows.length === 0) {
          return { fallbackReason: 'fts-no-candidates' }
        }

        const getChunk = db.prepare('SELECT chunk_text FROM chunks WHERE chunk_id = ?')
        const getEmbedding = db.prepare(
          'SELECT vector_json, dimensions FROM chunk_embeddings WHERE chunk_id = ?',
        )
        const getDocument = db.prepare(
          'SELECT id, title, file_path, created_at, updated_at, tags_json, doc_type FROM documents WHERE id = ?',
        )

        const docScores = new Map<string, { score: number; bestChunk: string; lexical: number }>()

        for (const candidate of candidateRows) {
          if (Date.now() - startTime > this.hybridMaxMs) {
            console.warn('[kb-hybrid] latency budget exceeded; falling back to lexical query path')
            return { fallbackReason: 'latency-budget-exceeded' }
          }

          const chunkRow = getChunk.get(candidate.chunk_id) as { chunk_text?: string } | undefined
          const embRow = getEmbedding.get(candidate.chunk_id) as
            | { vector_json?: string; dimensions?: number }
            | undefined

          const chunkText = chunkRow?.chunk_text ?? ''
          const lexicalScore = toLexicalScore(candidate.lexical_rank)
          const vectorScore = this.computeVectorScore(query, chunkText, embRow)
          const baseCombined = this.hybridAlpha * lexicalScore + (1 - this.hybridAlpha) * vectorScore
          const hintBoost = hintBoosts.get(candidate.doc_id) ?? 0
          const combined = Math.min(1, baseCombined + hintBoost)

          const current = docScores.get(candidate.doc_id)
          if (!current || combined > current.score) {
            docScores.set(candidate.doc_id, {
              score: combined,
              bestChunk: chunkText,
              lexical: lexicalScore,
            })
          }
        }

        const ranked = [...docScores.entries()]
          .map(([docId, scoreInfo]) => ({
            docId,
            ...scoreInfo,
          }))
          .sort((a, b) => b.score - a.score)

        const limit = input.limit ?? 10
        const filtered: QueryResult[] = []

        for (const row of ranked) {
          if (filtered.length >= limit) break

          const doc = getDocument.get(row.docId) as
            | {
              id: string
              title: string
              file_path: string
              created_at: string
              updated_at: string
              tags_json?: string
              doc_type?: QueryDocumentsInput['type']
            }
            | undefined
          if (!doc) continue

          if (input.type && doc.doc_type !== input.type) {
            continue
          }

          let content: string | undefined
          if (input.includeContent) {
            try {
              content = await readFile(doc.file_path, 'utf8')
            } catch {
              content = row.bestChunk
            }
          }

          filtered.push({
            metadata: {
              id: doc.id,
              title: doc.title,
              filePath: doc.file_path,
              createdAt: doc.created_at,
              updatedAt: doc.updated_at,
              tags: parseTagsJson(doc.tags_json),
              type: doc.doc_type,
            },
            content,
          })
        }

        return {
          response: {
            results: filtered,
            total: filtered.length,
            retrieval: {
              method: 'hybrid',
              detail: 'fts+vector-rerank',
            },
          },
        }
      } finally {
        db.close()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[kb-hybrid] query unavailable, using lexical fallback: ${message}`)
      return { fallbackReason: `hybrid-error:${message}` }
    }
  }

  private computeVectorScore(
    query: string,
    chunkText: string,
    embRow: { vector_json?: string; dimensions?: number } | undefined,
  ): number {
    if (!chunkText) return 0

    if (!embRow?.vector_json || !embRow.dimensions) {
      return heuristicVectorScore(query, chunkText)
    }

    try {
      const stored = JSON.parse(embRow.vector_json) as number[]
      if (!Array.isArray(stored) || stored.length === 0) {
        return heuristicVectorScore(query, chunkText)
      }

      const queryVec = buildDeterministicVector(query, embRow.dimensions)
      const cosine = cosineSimilarity(queryVec, stored)
      return (cosine + 1) / 2
    } catch {
      return heuristicVectorScore(query, chunkText)
    }
  }

  private loadRankingHintBoosts(db: Database.Database, query: string): Map<string, number> {
    try {
      const fingerprint = buildQueryFingerprint(query)
      const rows = db
        .prepare(`
          SELECT doc_id, hint_score, occurrences
          FROM retrieval_ranking_hints
          WHERE query_fingerprint = ?
            AND occurrences >= ?
          ORDER BY hint_score DESC, occurrences DESC
          LIMIT 25
        `)
        .all(fingerprint, this.rankingHintMinOccurrences) as Array<{
          doc_id: string
          hint_score: number
          occurrences: number
        }>

      const boosts = new Map<string, number>()
      for (const row of rows) {
        const boundedBoost = Math.max(0, Math.min(0.2, row.hint_score * 0.2))
        boosts.set(row.doc_id, boundedBoost)
      }
      return boosts
    } catch {
      return new Map<string, number>()
    }
  }

  private maybeRecordMissLearning(input: QueryDocumentsInput, response: QueryResponse): void {
    if (!this.missLearningEnabled) return
    if (!input.query?.trim()) return

    const checkpoints = response.retrieval.checkpoints ?? []
    const finalCheckpoint = checkpoints.at(-1)
    const confidence = finalCheckpoint?.confidence ?? 0

    let missReason: 'no_candidates' | 'low_confidence' | null = null
    if (response.total === 0) {
      missReason = 'no_candidates'
    } else if (confidence < 0.45) {
      missReason = 'low_confidence'
    }

    if (!missReason) return

    const stage = finalCheckpoint?.stage ?? 'lexical_recovery'
    const topCandidates = response.results
      .slice(0, 5)
      .map((result, index) => ({
        id: result.metadata.id,
        score: Math.max(0.1, 1 - index * 0.1),
      }))

    const now = dayjs().toISOString()
    const fingerprint = buildQueryFingerprint(input.query)

    let db: Database.Database | undefined
    try {
      db = new Database(this.sqliteDbPath)

      db.prepare(`
        INSERT INTO retrieval_miss_events (
          query_fingerprint,
          raw_query,
          stage,
          miss_reason,
          top_candidates_json,
          surface,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        fingerprint,
        input.query,
        stage,
        missReason,
        JSON.stringify(topCandidates),
        'reader',
        now,
      )

      if (topCandidates.length === 0) return

      const upsertHint = db.prepare(`
        INSERT INTO retrieval_ranking_hints (
          query_fingerprint,
          doc_id,
          occurrences,
          hint_score,
          updated_at
        )
        VALUES (?, ?, 1, 0.1, ?)
        ON CONFLICT(query_fingerprint, doc_id) DO UPDATE SET
          occurrences = retrieval_ranking_hints.occurrences + 1,
          hint_score = MIN(1.0, retrieval_ranking_hints.hint_score + 0.1),
          updated_at = excluded.updated_at
      `)

      for (const candidate of topCandidates) {
        upsertHint.run(fingerprint, candidate.id, now)
      }
    } catch {
      // Miss-learning is best-effort and should not affect retrieval responses.
    } finally {
      db?.close()
    }
  }

  private maybeRecordCheckpointEvents(input: QueryDocumentsInput, response: QueryResponse): void {
    if (!this.checkpointObservabilityEnabled) return
    if (!input.query?.trim()) return

    const checkpoints = response.retrieval.checkpoints ?? []
    if (checkpoints.length === 0) return

    const fingerprint = buildQueryFingerprint(input.query)
    const now = dayjs().toISOString()

    let db: Database.Database | undefined
    try {
      db = new Database(this.sqliteDbPath)
      const insertCheckpoint = db.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const tx = db.transaction(() => {
        for (const checkpoint of checkpoints) {
          insertCheckpoint.run(
            fingerprint,
            checkpoint.stage,
            checkpoint.status,
            checkpoint.nextAction,
            checkpoint.confidence,
            checkpoint.method,
            checkpoint.detail ?? null,
            'reader',
            now,
          )
        }
      })

      tx()
    } catch {
      // Observability writes are best-effort and should not affect serving path.
    } finally {
      db?.close()
    }
  }
}

function evaluateDocumentMatch(
  input: QueryDocumentsInput,
  metadata: DocumentMetadata,
  content: string,
): MatchEvaluation {
  if (!input.query && !input.tags?.length) {
    return { matched: true, score: 10 }
  }

  if (input.tags?.length) {
    const hasAllTags = input.tags.every(tag =>
      metadata.tags?.some(t => t.toLowerCase() === tag.toLowerCase()),
    )

    return {
      matched: hasAllTags,
      score: hasAllTags ? 60 + input.tags.length : 0,
    }
  }

  const query = input.query ?? ''
  const normalizedQuery = normalizeText(query)
  const normalizedId = normalizeText(metadata.id)
  const normalizedTitle = normalizeText(metadata.title)

  if (input.mode === 'id') {
    const matched = normalizedId === normalizedQuery
    return { matched, score: matched ? 100 : 0 }
  }

  if (input.mode === 'title') {
    const matched = normalizedTitle.includes(normalizedQuery)
    return { matched, score: matched ? 80 + tokenOverlapCount(query, metadata.title) : 0 }
  }

  if (input.mode === 'content') {
    const score = contentMatchScore(query, content)
    return { matched: score > 0, score }
  }

  if (normalizedId === normalizedQuery) {
    return { matched: true, score: 100 }
  }

  if (normalizedTitle.includes(normalizedQuery)) {
    return { matched: true, score: 85 + tokenOverlapCount(query, metadata.title) }
  }

  const contentScore = contentMatchScore(query, content)
  return { matched: contentScore > 0, score: contentScore }
}

function buildKeywordQuery(query: string): string | undefined {
  const tokens = tokenize(query)
  if (tokens.length === 0) return undefined

  const ranked = [...new Set(tokens)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)

  if (ranked.length === 0) return undefined
  return ranked.join(' ')
}

function appendRetrievalDetail(base: string | undefined, suffix: string): string {
  if (!base) return suffix
  return `${base};${suffix}`
}

function buildQueryFingerprint(query: string): string {
  const normalized = query
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  return createHash('sha256').update(normalized).digest('hex')
}

function withCheckpoints(
  response: QueryResponse,
  checkpoints: RetrievalCheckpointRecord[],
): QueryResponse {
  return {
    ...response,
    retrieval: {
      ...response.retrieval,
      checkpoints,
    },
  }
}

function parseTagsJson(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as string[]
    if (!Array.isArray(parsed)) return undefined
    return parsed.filter(tag => typeof tag === 'string')
  } catch {
    return undefined
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBoundedNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < 0 || parsed > 1) return fallback
  return parsed
}

function toLexicalScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0

  // bm25 lower is better; convert to bounded score where 1 is best.
  if (rank <= 0) {
    return 1 / (1 + Math.abs(rank))
  }

  return 1 / (1 + rank)
}

function heuristicVectorScore(query: string, chunkText: string): number {
  const queryTokens = new Set(tokenize(query))
  const chunkTokens = new Set(tokenize(chunkText))
  if (queryTokens.size === 0 || chunkTokens.size === 0) return 0

  let overlap = 0
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) overlap += 1
  }

  return overlap / queryTokens.size
}

function buildDeterministicVector(input: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const sourceTokens = tokenize(input)
  const tokens = sourceTokens.length ? sourceTokens : ['query']

  for (let i = 0; i < dimensions; i++) {
    const token = tokens[i % tokens.length]
    const charCode = token.charCodeAt(i % token.length)
    vector[i] = ((charCode % 32) / 31) * 2 - 1
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude === 0 ? vector : vector.map(value => value / magnitude)
}

function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length)
  if (size === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
