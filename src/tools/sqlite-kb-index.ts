import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import dayjs from 'dayjs'
import Database from 'better-sqlite3'

interface ChunkRecord {
  chunkId: string
  chunkIndex: number
  headingPath: string
  chunkText: string
  tokenCount: number
}

export interface SqliteKbIndexerOptions {
  dbPath: string
  modelId?: string
  vectorDimensions?: number
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
    const chunks = buildChunks(parsed.id, parsed.contentBody)
    const contentHash = sha256(content)

    const upsertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, file_path, doc_type, tags_json, content_hash, created_at, updated_at, indexed_at)
      VALUES (@id, @title, @filePath, @docType, @tagsJson, @contentHash, @createdAt, @updatedAt, @indexedAt)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        file_path=excluded.file_path,
        doc_type=excluded.doc_type,
        tags_json=excluded.tags_json,
        content_hash=excluded.content_hash,
        updated_at=excluded.updated_at,
        indexed_at=excluded.indexed_at
    `)

    const deleteChunks = this.db.prepare('DELETE FROM chunks WHERE doc_id = ?')
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (chunk_id, doc_id, chunk_index, heading_path, chunk_text, token_count)
      VALUES (@chunkId, @docId, @chunkIndex, @headingPath, @chunkText, @tokenCount)
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
        filePath,
        docType: parsed.docType,
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
    `)
  }
}

interface ParsedDocument {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  tags: string[]
  docType: string | null
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

function buildChunks(documentId: string, body: string): ChunkRecord[] {
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
      headingPath: 'document',
      chunkText: fallbackText,
      tokenCount: fallbackText.split(/\s+/).filter(Boolean).length,
    })
  }

  return chunks
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