/**
 * KB Tools Registry Factory
 * Creates and registers write_document and read_documents tools
 */

import path from 'path'
import type { ToolExecutor } from '../core/tool-registry'
import { createToolRegistry } from '../core/tool-registry'
import type { ToolDefinition } from '../core/types'
import { MarkdownMDWriterTool } from './markdown-md-writer-tool'
import { MarkdownDocumentReader, type QueryDocumentsInput, type QueryResponse } from './markdown-document-reader'
import type { WriteDocumentInput } from './document-writer'

/**
 * Factory: create KB tools registry with write + read
 */
export function createKBToolsRegistry(baseDir?: string): ToolExecutor {
  const registry = createToolRegistry()
  const storageDir = baseDir ?? path.join(process.cwd(), 'sessions', 'documents')

  // Initialize storage implementations
  const writer = new MarkdownMDWriterTool({ baseDir: storageDir })
  const reader = new MarkdownDocumentReader(storageDir)

  // Register write_document tool
  const writeToolDef: ToolDefinition = {
    name: 'write_document',
    description: 'Write or append a document to the KB',
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Document title (becomes H1)',
        },
        content: {
          type: 'string',
          description: 'Markdown body content',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
        documentId: {
          type: 'string',
          description: 'Optional custom ID (auto-slugified if omitted)',
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite existing document (default: false)',
        },
      },
      required: ['title', 'content'],
    },
  }

  registry.register('write_document', writeToolDef, async (input) => {
    return await writer.writeDocument(input as unknown as WriteDocumentInput)
  })

  // Register read_documents tool
  const readToolDef: ToolDefinition = {
    name: 'read_documents',
    description: 'Query documents from the KB by title, ID, or tags',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text or document ID',
        },
        mode: {
          type: 'string',
          enum: ['id', 'title', 'tags'],
          description: 'Search mode: id (exact ID), title (substring), tags (AND logic)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags (must have ALL to match)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10)',
        },
        includeContent: {
          type: 'boolean',
          description: 'Whether to include full document content (default: false)',
        },
      },
    },
  }

  registry.register('read_documents', readToolDef, async (input) => {
    return await reader.queryDocuments(input as QueryDocumentsInput)
  })

  return registry
}

export { MarkdownDocumentReader }
export type { QueryResponse, QueryDocumentsInput }
