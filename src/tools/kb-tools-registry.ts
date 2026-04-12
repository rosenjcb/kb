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
import {
  executeWriteDocumentTool,
  type AppendToDocumentInput,
  type MergeDocumentsInput,
  type PruneDocumentInput,
  type UpdateDocumentInput,
} from './document-writer'

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
    description: 'Create or overwrite a document in the KB',
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
        type: {
          type: 'string',
          enum: ['architecture', 'decision', 'checklist', 'runbook', 'reference'],
          description: 'Optional document type',
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
    return await executeWriteDocumentTool(input, writer)
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
        type: {
          type: 'string',
          enum: ['architecture', 'decision', 'checklist', 'runbook', 'reference'],
          description: 'Optional document type filter',
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

  // append_to_document
  const appendToolDef: ToolDefinition = {
    name: 'append_to_document',
    description: 'Append markdown content to an existing document',
    schema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Existing document ID' },
        content: { type: 'string', description: 'Markdown content to append' },
        position: {
          type: 'string',
          enum: ['top', 'bottom'],
          description: 'Optional append position (default: bottom)',
        },
      },
      required: ['documentId', 'content'],
      additionalProperties: false,
    },
  }
  registry.register('append_to_document', appendToolDef, async (input) => {
    return await writer.appendToDocument(input as unknown as AppendToDocumentInput)
  })

  // update_document
  const updateToolDef: ToolDefinition = {
    name: 'update_document',
    description: 'Replace the full content of an existing document',
    schema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Existing document ID' },
        content: { type: 'string', description: 'New full markdown content' },
        title: { type: 'string', description: 'Optional new title' },
      },
      required: ['documentId', 'content'],
      additionalProperties: false,
    },
  }
  registry.register('update_document', updateToolDef, async (input) => {
    return await writer.updateDocument(input as unknown as UpdateDocumentInput)
  })

  // prune_document
  const pruneToolDef: ToolDefinition = {
    name: 'prune_document',
    description: 'Remove a document section by heading/pattern',
    schema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Existing document ID' },
        prunePattern: { type: 'string', description: 'Section heading/pattern to remove' },
      },
      required: ['documentId', 'prunePattern'],
      additionalProperties: false,
    },
  }
  registry.register('prune_document', pruneToolDef, async (input) => {
    return await writer.pruneDocument(input as unknown as PruneDocumentInput)
  })

  // merge_documents
  const mergeToolDef: ToolDefinition = {
    name: 'merge_documents',
    description: 'Merge two documents with auto or user-decides mode',
    schema: {
      type: 'object',
      properties: {
        sourceDocId: { type: 'string', description: 'Source document ID' },
        targetDocId: { type: 'string', description: 'Target document ID' },
        mergeMode: {
          type: 'string',
          enum: ['auto', 'user-decides'],
          description: 'Merge mode behavior',
        },
      },
      required: ['sourceDocId', 'targetDocId', 'mergeMode'],
      additionalProperties: false,
    },
  }
  registry.register('merge_documents', mergeToolDef, async (input) => {
    return await writer.mergeDocuments(input as unknown as MergeDocumentsInput)
  })

  return registry
}

export { MarkdownDocumentReader }
export type { QueryResponse, QueryDocumentsInput }
