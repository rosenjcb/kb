/**
 * KB Tools Registry Factory
 * Creates and registers write_document and read_documents tools
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
import {
  MarkdownDocumentReader,
  type QueryDocumentsInput,
  type QueryResponse,
} from './markdown-document-reader'
import { SqliteDocumentWriter } from './sqlite-document-writer'
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
  const flags = config ? resolveFeatureFlags(config) : undefined
  const reader = new MarkdownDocumentReader(
    storageDir,
    flags
      ? {
          hybridEnabled: flags.hybridQuery,
          graphRankingEnabled: config ? resolveGraphEnabled(config) : undefined,
          hybridCandidateLimit: flags.hybridQueryCandidates,
          hybridAlpha: flags.hybridQueryAlpha,
          hybridMaxMs: flags.hybridQueryMaxMs,
          checkpointObservabilityEnabled: flags.checkpointObservability,
          missLearningEnabled: flags.missLearning,
          rankingHintsEnabled: flags.missHints,
          rankingHintMinOccurrences: flags.missHintMinOccurrences,
          laneRoutingEnabled: flags.laneRouting,
        }
      : {}
  )

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
  registry.register('append_to_document', appendToolDef, async input => {
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
  registry.register('update_document', updateToolDef, async input => {
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
  registry.register('prune_document', pruneToolDef, async input => {
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
        throw new Error('orchestrator.taskProvider is undefined');
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

export { MarkdownDocumentReader }
export type { QueryResponse, QueryDocumentsInput }
