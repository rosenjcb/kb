/**
 * Document reader for querying markdown-based KB
 * See: Ticket 008 - Query Documents Tool Contract
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import Database from 'better-sqlite3'

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
  }
}

export interface MarkdownDocumentReaderOptions {
  hybridEnabled?: boolean
  sqliteDbPath?: string
  hybridCandidateLimit?: number
  hybridAlpha?: number
  hybridMaxMs?: number
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token))
}

function hasTokenOverlap(query: string, content: string): boolean {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return false

  const contentTokens = new Set(tokenize(content))
  let overlapCount = 0
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlapCount += 1
    }
  }

  const minOverlap = queryTokens.size >= 4 ? 2 : 1
  return overlapCount >= minOverlap
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

  constructor(
    private baseDir: string,
    options: MarkdownDocumentReaderOptions = {},
  ) {
    this.hybridEnabled = options.hybridEnabled ?? process.env.KB_HYBRID_QUERY === 'true'
    this.sqliteDbPath = options.sqliteDbPath ?? path.join(baseDir, '.kb-index.sqlite')
    this.hybridCandidateLimit = options.hybridCandidateLimit ?? parsePositiveInt(process.env.KB_HYBRID_QUERY_CANDIDATES, 40)
    this.hybridAlpha = options.hybridAlpha ?? parseBoundedNumber(process.env.KB_HYBRID_QUERY_ALPHA, 0.45)
    this.hybridMaxMs = options.hybridMaxMs ?? parsePositiveInt(process.env.KB_HYBRID_QUERY_MAX_MS, 120)
  }

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    if (this.shouldUseHybrid(input)) {
      const hybridAttempt = await this.tryHybridQuery(input)
      if (hybridAttempt.response) {
        return {
          ...hybridAttempt.response,
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
          },
        }
      }

      return this.queryDocumentsLexical(input, {
        method: 'lexical-fallback',
        detail: hybridAttempt.fallbackReason ?? 'hybrid-unavailable',
      })
    }

    return this.queryDocumentsLexical(input, {
      method: 'lexical',
      detail: 'hybrid-not-attempted',
    })
  }

  private async queryDocumentsLexical(
    input: QueryDocumentsInput,
    retrieval: QueryResponse['retrieval'],
  ): Promise<QueryResponse> {
    const limit = input.limit ?? 10
    let results: QueryResult[] = []

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

        // Filter by query and mode
        if (input.query && input.mode === 'id') {
          if (metadata.id === input.query) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (input.query && input.mode === 'title') {
          if (metadata.title.toLowerCase().includes(input.query.toLowerCase())) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (input.query && input.mode === 'content') {
          if (
            content.toLowerCase().includes(input.query.toLowerCase())
            || hasTokenOverlap(input.query, content)
          ) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (input.tags?.length) {
          // AND logic: all provided tags must be in document
          const hasAllTags = input.tags.every(tag =>
            metadata.tags?.some(t => t.toLowerCase() === tag.toLowerCase())
          )
          if (hasAllTags) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (!input.query && !input.tags?.length) {
          // No filter: return all (recent first)
          results.push({
            metadata,
            content: input.includeContent ? content : undefined,
          })
        } else if (input.query && !input.mode) {
          // Auto-mode: try ID first, then title, then content match.
          if (metadata.id === input.query) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          } else if (metadata.title.toLowerCase().includes(input.query.toLowerCase())) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          } else if (
            content.toLowerCase().includes(input.query.toLowerCase())
            || hasTokenOverlap(input.query, content)
          ) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        }

        if (results.length >= limit) break
      }
    } catch {
      // KB directory doesn't exist or is empty; return empty results
      return { results: [], total: 0, retrieval }
    }

    return {
      results: results.slice(0, limit),
      total: results.length,
      retrieval,
    }
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
          const combined = this.hybridAlpha * lexicalScore + (1 - this.hybridAlpha) * vectorScore

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
