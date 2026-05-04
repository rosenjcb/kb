import { DOC_TYPES, type DocType, isDocType } from '../core/doc-taxonomy'
import type { ToolDefinition } from '../core/types'

/**
 * SQLite-backed markdown originals and derived docs. **`kb init` / rescan** ingest repo files by calling
 * `SqliteDocumentWriter` from scripted passes (first-loop pipeline), not by routing through these tool schemas.
 * **`executeWriteDocumentTool`** is what the **agent registry** binds for `write_document` / append / etc.
 * Routine knowledge: facts (`kb submit`) + graph tools + `kb docs` to browse corpora.
 */

export interface WriteDocumentInput {
  title: string
  content: string
  tags?: string[]
  type?: DocType
  documentId?: string
  overwrite?: boolean
  isOriginal?: boolean
}

// ─── Specialized Document Operation Types ───────────────────────
// Following separation-of-concerns pattern: one tool per operation

export interface AppendToDocumentInput {
  documentId: string
  content: string
  position?: 'top' | 'bottom' // Defaults to 'bottom'
}

export interface UpdateDocumentInput {
  documentId: string
  content: string
  title?: string // Optional: update title if provided
}

export interface MergeDocumentsInput {
  sourceDocId: string
  targetDocId: string
  mergeMode: 'auto' | 'user-decides'
}

export interface MergeDocumentsResult {
  targetDocId: string
  sourceDocIds: string[]
  status: 'merged' | 'merge-pending-approval'
  note?: string
}

export interface PruneDocumentInput {
  documentId: string
  prunePattern: string // Section name or regex pattern to remove
}

export interface ReconcileFactsInput {
  replaceFrom: string
  replaceTo: string
  includeSessionLogs?: boolean
  apply?: boolean
}

export interface ReconcileContradictionsInput {
  newFact: string
  domain?: string
  includeSessionLogs?: boolean
  apply?: boolean
}

export interface ReconcileFactsDiffPreview {
  documentId: string
  filePath: string
  replacements: number
  diff: string
}

export interface ReconcileFactsResult {
  replaceFrom: string
  replaceTo: string
  apply: boolean
  scannedDocs: number
  changedDocs: number
  skippedDocs: number
  totalReplacements: number
  changedDocumentIds: string[]
  skippedDocumentIds: string[]
  proposedDiffs: ReconcileFactsDiffPreview[]
  discovery: {
    strategy: 'index-assisted+full-crawl' | 'full-crawl'
    indexCandidateCount: number
  }
}

export interface ReconcileContradictionsResult {
  newFact: string
  domain: string
  apply: boolean
  scannedDocs: number
  changedDocs: number
  removedFacts: number
  changedDocumentIds: string[]
  proposedDiffs: ReconcileFactsDiffPreview[]
}

// ─── Extended DocumentWriter Interface ───────────────────────
// Storage implementations should support these new operations

export interface DocumentWriterExtended extends DocumentWriter {
  appendToDocument?(input: AppendToDocumentInput): Promise<WriteDocumentResult>
  updateDocument?(input: UpdateDocumentInput): Promise<WriteDocumentResult>
  mergeDocuments?(input: MergeDocumentsInput): Promise<MergeDocumentsResult>
  pruneDocument?(input: PruneDocumentInput): Promise<WriteDocumentResult>
  reconcileFacts?(input: ReconcileFactsInput): Promise<ReconcileFactsResult>
  reconcileContradictions?(
    input: ReconcileContradictionsInput
  ): Promise<ReconcileContradictionsResult>
}

export interface WriteDocumentResult {
  id: string
  title: string
  filePath: string
  createdAt: string
  updatedAt: string
}

/**
 * Storage interface for document writing.
 * Keep this stable so we can add a Notion-backed implementation later.
 */
export interface DocumentWriter {
  writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult>
}

export const writeDocumentTool: ToolDefinition = {
  name: 'write_document',
  description: 'Create or update a markdown document in the knowledge workspace.',
  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Human-readable document title.',
      },
      content: {
        type: 'string',
        description: 'Markdown body to write into the document.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for indexing and retrieval.',
      },
      type: {
        type: 'string',
        enum: [...DOC_TYPES],
        description: 'Optional document type for operation semantics and filtering.',
      },
      documentId: {
        type: 'string',
        description: 'Optional stable id/slug. If omitted, generated from title.',
      },
      overwrite: {
        type: 'boolean',
        description: 'When true, replace existing file content. Defaults to false.',
      },
    },
    required: ['title', 'content'],
    additionalProperties: false,
  },
}

export async function executeWriteDocumentTool(
  input: unknown,
  writer: DocumentWriter
): Promise<WriteDocumentResult> {
  const parsed = parseWriteDocumentInput(input)
  return writer.writeDocument(parsed)
}

function parseWriteDocumentInput(input: unknown): WriteDocumentInput {
  if (!input || typeof input !== 'object') {
    throw new Error('write_document expects an object input')
  }

  const candidate = input as Record<string, unknown>
  const title = asNonEmptyString(candidate.title, 'title')
  const content = asString(candidate.content, 'content')
  const tags = parseTags(candidate.tags)
  const type = parseOptionalType(candidate.type)
  const documentId = parseOptionalString(candidate.documentId)
  const overwrite = parseOptionalBoolean(candidate.overwrite)

  return {
    title,
    content,
    tags,
    type,
    documentId,
    overwrite,
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`write_document: ${field} must be a string`)
  }
  return value
}

function asNonEmptyString(value: unknown, field: string): string {
  const parsed = asString(value, field).trim()
  if (!parsed) {
    throw new Error(`write_document: ${field} cannot be empty`)
  }
  return parsed
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error('write_document: documentId must be a string when provided')
  }
  return value.trim() || undefined
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error('write_document: overwrite must be a boolean when provided')
  }
  return value
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) {
    throw new Error('write_document: tags must be an array of strings when provided')
  }

  const normalized = value.map(tag => tag.trim()).filter(Boolean)
  return normalized.length ? normalized : undefined
}

function parseOptionalType(value: unknown): WriteDocumentInput['type'] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error('write_document: type must be a string when provided')
  }

  if (!isDocType(value)) {
    throw new Error(`write_document: type must be one of ${DOC_TYPES.join(', ')}`)
  }

  return value
}
