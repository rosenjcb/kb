/**
 * KB Tools Registry Factory
 *
 * **Facts** (`upsert_fact`, `read_documents` deep path) are the primary retrieval surface for `kb query` / chat.
 * **Markdown documents** (`write_document`, `append_to_document`, …) stay registered for `kb init`, rescan apply,
 * and agent-orchestrated pipelines—not the long-term human authoring path. Browse with `kb docs`; a dedicated
 * generator (e.g. `kb docs generate "…"`) is future work.
 */

import path from 'node:path'
import { getKbHomeDir } from '../cli/base-selection'
import type { KbConfig } from '../cli/kb-config'
import { resolveFeatureFlags, resolveGraphEnabled } from '../cli/kb-config'
import type { StreamManager } from '../core/runtime/stream-manager'
import type { ToolExecutor } from '../core/tool-registry'
import { createToolRegistry } from '../core/tool-registry'
import type { LLMProvider, ToolDefinition } from '../core/types'
import {
  type AppendToDocumentInput,
  type MergeDocumentsInput,
  type PruneDocumentInput,
  type ReconcileContradictionsInput,
  type ReconcileFactsInput,
  type UpdateDocumentInput,
  executeWriteDocumentTool,
} from './document-writer'
import { DuckGraphWriter } from './duck-graph-writer'
import { FactsDocumentReader } from './facts-document-reader'
import { extractGraph } from './graph-entity-extractor'
import { invalidateFactTool } from './invalidate-fact-tool'
import type { QueryDocumentsInput, QueryResponse } from './facts-document-reader'
import { SqliteDocumentWriter } from './sqlite-document-writer'
import { SqliteKbIndexer } from './sqlite-kb-index'
import { executeSubagentTask } from './task'

export interface KBToolsOrchestratorOptions {
  taskProvider?: LLMProvider
  streamManager?: StreamManager
}

/**
 * Factory: create KB tools registry with write + read
 */
export function createKBToolsRegistry(
  baseDir?: string,
  config?: KbConfig,
  orchestrator?: KBToolsOrchestratorOptions
): ToolExecutor {
  const registry = createToolRegistry()
  const storageDir = baseDir ?? path.join(getKbHomeDir(), 'sessions', 'default')

  // Initialize storage implementations
  const writer = new SqliteDocumentWriter({ baseDir: storageDir })
  if (config) resolveFeatureFlags(config)
  const indexer = new SqliteKbIndexer({ dbPath: path.join(storageDir, '.kb-index.sqlite') })
  const reader = new FactsDocumentReader(path.join(storageDir, '.kb-index.sqlite'))

  const writeToolDef: ToolDefinition = {
    name: 'write_document',
    description:
      'Create or overwrite a markdown KB document (init/rescan/agent orchestration). Routine knowledge: kb submit + kb docs.',
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

  registry.register('write_document', writeToolDef, async input => {
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
        discoveryDepth: {
          type: 'string',
          enum: ['shallow', 'deep'],
          description:
            'Discovery strategy: shallow (fast primary pass) or deep (broader exhaustive pass)',
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

  registry.register('read_documents', readToolDef, async input => {
    return await reader.queryDocuments(input as QueryDocumentsInput)
  })

  const upsertFactToolDef: ToolDefinition = {
    name: 'upsert_fact',
    description: 'Insert or update a canonical fact in the facts store',
    schema: {
      type: 'object',
      properties: {
        factText: { type: 'string', description: 'Atomic fact statement text' },
        sourceKind: {
          type: 'string',
          enum: ['submit', 'import_doc'],
          description: 'Source channel for this fact',
        },
        sourceRef: { type: 'string', description: 'Optional source provenance' },
        confidence: { type: 'number', description: 'Optional confidence between 0 and 1' },
      },
      required: ['factText', 'sourceKind'],
      additionalProperties: false,
    },
  }
  registry.register('upsert_fact', upsertFactToolDef, async input => {
    const payload = input as {
      factText: string
      sourceKind: 'submit' | 'import_doc'
      sourceRef?: string
      confidence?: number
    }
    return indexer.upsertFact(payload)
  })

  const generateDocToolDef: ToolDefinition = {
    name: 'generate_document_from_facts',
    description: 'Generate a derived markdown document from retrieved facts',
    schema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'User instruction for generated document' },
        title: { type: 'string', description: 'Output document title' },
        limit: { type: 'number', description: 'Fact retrieval limit (default: 20)' },
      },
      required: ['instruction', 'title'],
      additionalProperties: false,
    },
  }
  registry.register('generate_document_from_facts', generateDocToolDef, async input => {
    const payload = input as { instruction: string; title: string; limit?: number }
    const factRows = indexer.searchFacts(payload.instruction, payload.limit ?? 20)
    const markdownLines = [`# ${payload.title}`, '', `Instruction: ${payload.instruction}`, '', '## Evidence']
    for (const row of factRows) {
      markdownLines.push(`- ${row.fact_text}`)
    }
    if (factRows.length === 0) {
      markdownLines.push('- No supporting facts found.')
    }
    const id = slugify(payload.title)
    indexer.upsertDerivedDoc({
      id,
      title: payload.title,
      instruction: payload.instruction,
      markdown: `${markdownLines.join('\n')}\n`,
      sourceFactIds: factRows.map(row => row.id),
      status: 'active',
      tags: ['derived'],
      docType: 'reference',
    })
    return { id, title: payload.title, sourceFactCount: factRows.length }
  })

  const appendToolDef: ToolDefinition = {
    name: 'append_to_document',
    description:
      'Append markdown to a document (init/rescan/orchestration). Not the primary human authoring path.',
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
  registry.register('append_to_document', appendToolDef, async input => {
    return await writer.appendToDocument(input as unknown as AppendToDocumentInput)
  })

  const updateToolDef: ToolDefinition = {
    name: 'update_document',
    description:
      'Replace full markdown of a document (pipelines). Prefer kb submit for atomic facts; browse with kb docs.',
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
  registry.register('update_document', updateToolDef, async input => {
    return await writer.updateDocument(input as unknown as UpdateDocumentInput)
  })

  const pruneToolDef: ToolDefinition = {
    name: 'prune_document',
    description: 'Remove a markdown section (orchestration / maintenance tools).',
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
  registry.register('prune_document', pruneToolDef, async input => {
    return await writer.pruneDocument(input as unknown as PruneDocumentInput)
  })

  const mergeToolDef: ToolDefinition = {
    name: 'merge_documents',
    description: 'Merge two markdown documents (orchestration).',
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
  registry.register('merge_documents', mergeToolDef, async input => {
    return await writer.mergeDocuments(input as unknown as MergeDocumentsInput)
  })

  // reconcile_facts
  const reconcileFactsToolDef: ToolDefinition = {
    name: 'reconcile_facts',
    description:
      'Replace outdated fact references across documents with lane-aware exclusion rules',
    schema: {
      type: 'object',
      properties: {
        replaceFrom: { type: 'string', description: 'Old canonical term/value to replace' },
        replaceTo: { type: 'string', description: 'New canonical term/value' },
        includeSessionLogs: {
          type: 'boolean',
          description: 'When true, include session-log docs in reconciliation (default: false)',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, report changes without writing files',
        },
      },
      required: ['replaceFrom', 'replaceTo'],
      additionalProperties: false,
    },
  }
  registry.register('reconcile_facts', reconcileFactsToolDef, async input => {
    return await writer.reconcileFacts(input as unknown as ReconcileFactsInput)
  })

  const reconcileContradictionsToolDef: ToolDefinition = {
    name: 'reconcile_contradictions',
    description: 'Detect and remove contradictory fact lines based on a newly submitted fact',
    schema: {
      type: 'object',
      properties: {
        newFact: {
          type: 'string',
          description: 'Newly submitted fact text used as canonical claim',
        },
        domain: { type: 'string', description: 'Optional domain scope for contradiction cleanup' },
        includeSessionLogs: {
          type: 'boolean',
          description:
            'When true, include session-log docs in contradiction cleanup (default: false)',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, report cleanup plan without writing files',
        },
      },
      required: ['newFact'],
      additionalProperties: false,
    },
  }
  registry.register('reconcile_contradictions', reconcileContradictionsToolDef, async input => {
    return await writer.reconcileContradictions(input as unknown as ReconcileContradictionsInput)
  })

  const invalidateFactToolDef: ToolDefinition = {
    name: 'invalidate_fact',
    description: 'Preview or apply KB-only fact invalidation across stored documents',
    schema: {
      type: 'object',
      properties: {
        oldFact: { type: 'string', description: 'Existing fact text to remove or replace' },
        replacementFact: { type: 'string', description: 'Optional replacement fact text' },
        preview: { type: 'boolean', description: 'When true, report changes without applying' },
        dryRun: { type: 'boolean', description: 'When true, simulate writes without applying' },
        includeSessionLogs: {
          type: 'boolean',
          description: 'When true, include session-log documents in the invalidation scan',
        },
      },
      required: ['oldFact'],
      additionalProperties: false,
    },
  }
  registry.register('invalidate_fact', invalidateFactToolDef, async input => {
    return await invalidateFactTool(input as never, storageDir)
  })

  const upsertGraphFromTextToolDef: ToolDefinition = {
    name: 'upsert_graph_from_text',
    description: 'Extract graph entities/relationships from text and upsert them into DuckDB',
    schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Submitted fact or content to extract graph data from',
        },
        documentId: {
          type: 'string',
          description: 'Document provenance id for extracted graph items',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  }
  registry.register('upsert_graph_from_text', upsertGraphFromTextToolDef, async input => {
    if (!orchestrator?.taskProvider || !resolveGraphEnabled(config ?? {})) {
      return { enabled: false, entities: 0, relationships: 0 }
    }

    const text =
      typeof (input as { text?: unknown }).text === 'string' ? (input as { text: string }).text : ''
    const documentId =
      typeof (input as { documentId?: unknown }).documentId === 'string'
        ? (input as { documentId: string }).documentId
        : undefined

    const { entities, relationships } = await extractGraph(
      text,
      orchestrator.taskProvider,
      documentId
    )
    if (entities.length === 0 && relationships.length === 0) {
      return { enabled: true, entities: 0, relationships: 0 }
    }

    const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(storageDir))
    await graphWriter.open()
    try {
      if (entities.length > 0) await graphWriter.upsertEntities(entities)
      if (relationships.length > 0) await graphWriter.upsertRelationships(relationships)
    } finally {
      await graphWriter.close()
    }

    return { enabled: true, entities: entities.length, relationships: relationships.length }
  })

  const invalidateGraphDocumentsToolDef: ToolDefinition = {
    name: 'invalidate_graph_documents',
    description: 'Soft-delete graph relationships for affected document provenance ids',
    schema: {
      type: 'object',
      properties: {
        documentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Document ids whose graph relationships should be soft-deleted',
        },
      },
      required: ['documentIds'],
      additionalProperties: false,
    },
  }
  registry.register('invalidate_graph_documents', invalidateGraphDocumentsToolDef, async input => {
    if (!resolveGraphEnabled(config ?? {})) {
      return { enabled: false, invalidatedRelationships: 0, documentIds: [] as string[] }
    }

    const rawIds = Array.isArray((input as { documentIds?: unknown[] }).documentIds)
      ? ((input as { documentIds: unknown[] }).documentIds as unknown[])
      : []
    const documentIds = rawIds
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)

    if (documentIds.length === 0) {
      return { enabled: true, invalidatedRelationships: 0, documentIds: [] as string[] }
    }

    const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(storageDir))
    let invalidatedRelationships = 0
    await graphWriter.open()
    try {
      for (const documentId of documentIds) {
        invalidatedRelationships += await graphWriter.softDeleteByDocId(documentId)
      }
    } finally {
      await graphWriter.close()
    }

    return { enabled: true, invalidatedRelationships, documentIds }
  })

  if (orchestrator?.taskProvider) {
    const taskToolDef: ToolDefinition = {
      name: 'task',
      description:
        'Delegate a focused sub-instruction to a worker subagent with a restricted tool set. Returns structured output for the parent model.',
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Instruction for the worker agent' },
          agent_profile_id: {
            type: 'string',
            description:
              'Optional profile id registered in the agent registry (e.g. default, research)',
          },
          max_turns: { type: 'number', description: 'Maximum subagent turns (1–20)' },
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tool names the subagent may invoke; recursive task calls are never allowed',
          },
          isolation: {
            type: 'string',
            enum: ['shared_storage', 'forked_message_thread'],
            description:
              'Logical isolation strategy (v1 uses a fresh message thread; storage stays shared)',
          },
        },
        required: ['prompt'],
      },
    }

    registry.register('task', taskToolDef, async input => {
      if (!orchestrator.taskProvider) {
        throw new Error('orchestrator.taskProvider is undefined')
      }
      return executeSubagentTask({
        parentRegistry: registry,
        provider: orchestrator.taskProvider,
        input,
        streamManager: orchestrator.streamManager,
      })
    })
  }

  return registry
}

export type { QueryResponse, QueryDocumentsInput }

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'generated-doc'
  )
}
