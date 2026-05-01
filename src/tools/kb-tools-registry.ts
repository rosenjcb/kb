/**
 * KB Tools Registry Factory
 *
 * **Facts-first agent surface:** `read_facts`, `upsert_fact`, `invalidate_fact`, graph helpers, optional `task`.
 * Markdown documents are written by **`kb init` / rescan** via `SqliteDocumentWriter` in code — not via removed
 * write/append/merge tools. Use **`kb submit`** / **`kb docs`** for knowledge work.
 */

import path from 'node:path'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import { getKbHomeDir } from '../cli/base-selection'
import type { KbConfig } from '../cli/kb-config'
import { resolveFeatureFlags, resolveGraphEnabled } from '../cli/kb-config'
import { DOC_TYPES } from '../core/doc-taxonomy'
import type { StreamManager } from '../core/runtime/stream-manager'
import type { ToolExecutor } from '../core/tool-registry'
import { createToolRegistry } from '../core/tool-registry'
import type { LLMProvider, ToolDefinition } from '../core/types'
import { DuckGraphWriter } from './duck-graph-writer'
import { FactsDocumentReader } from './facts-document-reader'
import { extractGraph } from './graph-entity-extractor'
import { invalidateFactTool } from './invalidate-fact-tool'
import type { QueryDocumentsInput, QueryResponse } from './facts-document-reader'
import { SqliteKbIndexer } from './sqlite-kb-index'
import { executeSubagentTask } from './task'

export interface KBToolsOrchestratorOptions {
  taskProvider?: LLMProvider
  streamManager?: StreamManager
}

/**
 * Factory: KB tools for query/submit/invalidate and optional subagent `task`.
 */
export function createKBToolsRegistry(
  baseDir?: string,
  config?: KbConfig,
  orchestrator?: KBToolsOrchestratorOptions
): ToolExecutor {
  const registry = createToolRegistry()
  const storageDir = baseDir ?? path.join(getKbHomeDir(), 'sessions', 'default')

  if (config) resolveFeatureFlags(config)
  const indexer = new SqliteKbIndexer({ dbPath: path.join(storageDir, '.kb-index.sqlite') })
  const reader = new FactsDocumentReader(path.join(storageDir, '.kb-index.sqlite'))

  const readToolDef: ToolDefinition = {
    name: 'read_facts',
    description:
      'Search and retrieve canonical facts from the KB (hybrid / deep discovery). Prefer this over guessing.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text or fact id',
        },
        mode: {
          type: 'string',
          enum: ['id', 'title', 'tags', 'content'],
          description:
            'Search mode: id (exact), title substring, tags (AND), content (default for intent query)',
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
          enum: [...DOC_TYPES],
          description: 'Optional document type filter',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10)',
        },
        includeContent: {
          type: 'boolean',
          description: 'Whether to include full fact text in hits (default: false)',
        },
      },
    },
  }

  registry.register('read_facts', readToolDef, async input => {
    return await reader.queryDocuments(input as QueryDocumentsInput)
  })

  const upsertFactToolDef: ToolDefinition = {
    name: 'upsert_fact',
    description: 'Insert or update a canonical fact in the facts store',
    schema: {
      type: 'object',
      properties: {
        factText: { type: 'string', description: 'Atomic fact statement text' },
        triplet: {
          type: 'object',
          description: 'Explicit subject–predicate–object triple (recommended for agents)',
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
          },
          required: ['subject', 'predicate', 'object'],
          additionalProperties: false,
        },
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
      triplet?: { subject?: string; predicate?: string; object?: string }
      sourceKind: 'submit' | 'import_doc'
      sourceRef?: string
      confidence?: number
    }
    const t = payload.triplet
    const triplet =
      t && typeof t.subject === 'string' && typeof t.predicate === 'string' && typeof t.object === 'string'
        ? { subject: t.subject.trim(), predicate: t.predicate.trim(), object: t.object.trim() }
        : placeholderTripletFromFactText(payload.factText)
    return indexer.upsertFact({
      factText: payload.factText,
      triplet,
      sourceKind: payload.sourceKind,
      sourceRef: payload.sourceRef,
      confidence: payload.confidence,
    })
  })

  const invalidateFactToolDef: ToolDefinition = {
    name: 'invalidate_fact',
    description: 'Preview or apply KB-only fact invalidation in the facts store',
    schema: {
      type: 'object',
      properties: {
        oldFact: { type: 'string', description: 'Existing fact text to remove or replace' },
        replacementFact: { type: 'string', description: 'Optional replacement fact text' },
        replacementTriplet: {
          type: 'object',
          description: 'Optional explicit triple for replacement (when replacementFact is set)',
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
          },
          required: ['subject', 'predicate', 'object'],
          additionalProperties: false,
        },
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

  const invalidateGraphForFactToolDef: ToolDefinition = {
    name: 'invalidate_graph_for_fact',
    description:
      'Soft-delete graph relationships for affected fact provenance ids (same ids as upsert_graph_from_text documentId)',
    schema: {
      type: 'object',
      properties: {
        documentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fact / provenance ids whose graph relationships should be soft-deleted',
        },
      },
      required: ['documentIds'],
      additionalProperties: false,
    },
  }
  registry.register('invalidate_graph_for_fact', invalidateGraphForFactToolDef, async input => {
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
