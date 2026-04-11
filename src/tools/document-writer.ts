import type { ToolDefinition } from '../core/types'

export interface WriteDocumentInput {
  title: string
  content: string
  tags?: string[]
  documentId?: string
  overwrite?: boolean
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
  const documentId = parseOptionalString(candidate.documentId)
  const overwrite = parseOptionalBoolean(candidate.overwrite)

  return {
    title,
    content,
    tags,
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
