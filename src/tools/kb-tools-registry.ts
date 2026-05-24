/**
 * KB Tools Registry Factory
 *
 * **Facts-first agent surface:** `read_facts`, `upsert_fact`, graph helpers, optional `task`.
 * Markdown documents are written by `kb init` / rescan via `SqliteDocumentWriter`.
 */

import path from 'node:path'
import { getKbHomeDir } from '../cli/base-selection'
import type { KbConfig } from '../cli/kb-config'
import { resolveFactRetrievalMethod, resolveFeatureFlags } from '../cli/kb-config'
import { DOC_TYPES } from '../core/doc-taxonomy'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import type { StreamManager } from '../core/runtime/stream-manager'
import type { ToolExecutor } from '../core/tool-registry'
import { createToolRegistry } from '../core/tool-registry'
import type { LLMProvider, ToolDefinition } from '../core/types'
import { CodeGraphStore } from './code-graph-store'
import { FactsDocumentReader } from './facts-document-reader'
import type { QueryDocumentsInput, QueryResponse } from './facts-document-reader'
import { SqliteKbIndexer } from './sqlite-kb-index'
import { executeSubagentTask } from './task'

export interface KBToolsOrchestratorOptions {
  taskProvider?: LLMProvider
  streamManager?: StreamManager
}

/**
 * Factory: KB tools for query and optional subagent `task`.
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
  const reader = new FactsDocumentReader(
    path.join(storageDir, '.kb-index.sqlite'),
    orchestrator?.taskProvider,
    resolveFactRetrievalMethod(config ?? {}) === 'all_facts'
  )

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
          enum: ['import_doc', 'import_code'],
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
      sourceKind: 'import_doc' | 'import_code'
      sourceRef?: string
      confidence?: number
    }
    const t = payload.triplet
    const triplet =
      t &&
      typeof t.subject === 'string' &&
      typeof t.predicate === 'string' &&
      typeof t.object === 'string'
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

  const codeGraphDbPath = path.join(storageDir, '.kb-index.sqlite')

  registry.register(
    'search_code_symbols',
    {
      name: 'search_code_symbols',
      description:
        'Full-text search over code symbols (functions, classes, interfaces, etc.) in the code graph. Use this when the user asks about specific code constructs.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or keyword to search for' },
          kind: {
            type: 'string',
            description:
              'Optional symbol kind filter (e.g. ClassDeclaration, FunctionDeclaration, InterfaceDeclaration)',
          },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async input => {
      const { query, kind, limit } = input as { query: string; kind?: string; limit?: number }
      const store = new CodeGraphStore(codeGraphDbPath)
      try {
        return store.searchSymbols(query, { kind, limit })
      } finally {
        store.close()
      }
    }
  )

  registry.register(
    'get_code_neighbors',
    {
      name: 'get_code_neighbors',
      description:
        'Get the immediate neighbors (imports, exports, extends, implements) of a code node by its id. Use after search_code_symbols to explore relationships.',
      schema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Node id, e.g. file:src/tools/foo.ts or symbol:src/tools/foo.ts#Bar',
          },
          edgeTypes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter to specific edge types: IMPORTS_FILE, EXPORTS_SYMBOL, EXTENDS, IMPLEMENTS',
          },
          direction: {
            type: 'string',
            enum: ['out', 'in', 'both'],
            description: 'Edge direction (default: both)',
          },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async input => {
      const { id, edgeTypes, direction, limit } = input as {
        id: string
        edgeTypes?: string[]
        direction?: 'out' | 'in' | 'both'
        limit?: number
      }
      const store = new CodeGraphStore(codeGraphDbPath)
      try {
        return store.getNeighbors(id, { edgeTypes, direction, limit })
      } finally {
        store.close()
      }
    }
  )

  registry.register(
    'get_code_graph_summary',
    {
      name: 'get_code_graph_summary',
      description: 'Get a summary of the indexed code graph (node/edge counts, last indexed time).',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    async () => {
      const store = new CodeGraphStore(codeGraphDbPath)
      try {
        return store.getSummary()
      } finally {
        store.close()
      }
    }
  )

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
