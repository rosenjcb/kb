/**
 * Transport-agnostic KB service core.
 *
 * Built once at server boot and reused across every HTTP request and MCP tool
 * call. Holds the resolved base, LLM provider, and tool registry in memory so
 * requests don't re-bootstrap. All retrieval flows through `runQueryPipeline`,
 * guaranteeing the server and CLI share one code path.
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider, Message } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import { createKBToolsRegistry } from '../tools/kb-tools-registry.js'
import { kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { maybeAutoSync } from '../cli/auto-sync.js'
import { readBaseMeta } from '../cli/base-meta.js'
import { applyConfigToEnv, createLLMProviderFromConfig, type KbConfig } from '../cli/kb-config.js'
import { type ChatEvent, streamChatTurn } from './chat-stream.js'
import { runQueryPipeline, type QueryPipelineParams } from './query-pipeline.js'
import { SessionStore } from './session-store.js'

export interface KbServiceOptions {
  /** Resolved absolute base directory (contains `.kb-index.sqlite`). */
  baseDir: string
  config: KbConfig
  bootstrapState?: {
    indexing: boolean
    error?: string
    progressLine?: string
    settled?: Promise<void>
  }
}

export interface ChatParams {
  sessionId: string
  message: string
}

export interface KbHealth {
  ok: boolean
  base: string
  provider?: string
  model?: string
  /** ISO mtime of the on-disk index, when present. */
  indexMtime?: string
  /** True while a fresh-volume bootstrap index build is running in the background. */
  indexing?: boolean
  /** Sticky bootstrap failure message when the background build crashed. */
  bootstrapError?: string
  /** Latest bootstrap progress line from the existing init/scan formatter. */
  bootstrapProgress?: string
  /** True while an incremental rescan is in progress; results may reflect stale data. */
  reindexing?: boolean
}

export const BOOTSTRAP_INDEXING_MESSAGE = 'server is indexing its knowledge base; try again soon'

export interface KbService {
  readonly baseDir: string
  readonly toolExecutor: ToolExecutor
  readonly llmProvider?: LLMProvider
  query(params: QueryPipelineParams): Promise<IntentResult>
  /** Stream one chat turn; maintains per-session history in memory. */
  chat(params: ChatParams): AsyncGenerator<ChatEvent>
  readFacts(params: Record<string, unknown>): Promise<unknown>
  /** Run one incremental rescan. Throws if a reindex is already in progress. */
  reindex(onProgress?: (line: string) => void): Promise<string>
  isReindexing(): boolean
  waitForBootstrap(): Promise<void>
  health(): KbHealth
  close(): Promise<void>
}

export function createKbService(options: KbServiceOptions): KbService {
  const { baseDir, config, bootstrapState } = options

  // Provider keys (and feature flags) come from config/env; apply once.
  applyConfigToEnv(config)
  const llmProvider = createLLMProviderFromConfig(config)
  const toolExecutor = createKBToolsRegistry(baseDir, config, {
    taskProvider: llmProvider ?? undefined,
  })

  // Single in-process writer guard: the only write paths are reindex (manual or
  // scheduled). Reads are unaffected (WAL allows concurrent readers).
  let reindexing = false
  const sessions = new SessionStore()

  return {
    baseDir,
    toolExecutor,
    llmProvider: llmProvider ?? undefined,

    async query(params) {
      return runQueryPipeline({ toolExecutor, llmProvider: llmProvider ?? undefined, baseDir, config }, params)
    },

    async *chat(params) {
      if (!llmProvider) {
        yield { type: 'error', message: 'no LLM provider configured (set an API key)' }
        return
      }
      const message = params.message.trim()
      if (!message) {
        yield { type: 'error', message: 'message is required' }
        return
      }

      const userMessage: Message = { role: 'user', content: message }
      const history = sessions.get(params.sessionId)
      let answer = ''

      for await (const event of streamChatTurn(
        { llmProvider, toolExecutor, baseDir },
        { question: message, messages: [...history, userMessage] }
      )) {
        if (event.type === 'answer') answer = event.text
        yield event
      }

      if (answer) {
        sessions.append(params.sessionId, userMessage, { role: 'assistant', content: answer })
      }
    },

    async readFacts(params) {
      return toolExecutor.execute({ id: 'kb-service', name: 'read_facts', input: params })
    },

    async reindex(onProgress) {
      if (reindexing) {
        throw new Error('reindex already in progress')
      }
      reindexing = true
      try {
        const meta = await readBaseMeta(baseDir)
        if (!meta || meta.repos.length === 0) {
          throw new Error(
            'This base has no git repos to scan. Add one with `kb base repo add <url>` or create a base with `kb init --git <url>`.'
          )
        }
        await maybeAutoSync(baseDir, { onProgress, staleLimitMs: 0 })
        return `Scanned ${meta.repos.length} repo(s) for base "${path.basename(baseDir)}".`
      } finally {
        reindexing = false
      }
    },

    isReindexing: () => reindexing,

    waitForBootstrap: async () => {
      await bootstrapState?.settled
    },

    health() {
      let indexMtime: string | undefined
      try {
        indexMtime = statSync(kbIndexDbPath(baseDir)).mtime.toISOString()
      } catch {
        indexMtime = undefined
      }
      return {
        ok: true,
        base: path.basename(baseDir),
        provider: llmProvider?.name,
        model: llmProvider?.model,
        indexMtime,
        ...(bootstrapState?.indexing ? { indexing: true } : {}),
        ...(bootstrapState?.error ? { bootstrapError: bootstrapState.error } : {}),
        ...(bootstrapState?.progressLine ? { bootstrapProgress: bootstrapState.progressLine } : {}),
        ...(reindexing ? { reindexing: true } : {}),
      }
    },

    async close() {
      // Connections are short-lived (opened per read); nothing to flush here.
    },
  }
}
