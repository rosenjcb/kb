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
import {
  type KbConfig,
  applyConfigToEnv,
  createLLMProviderFromConfig,
} from '@kb/core/config/kb-config.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider, Message } from '@kb/core/core/types.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import { scanBaseRepos } from '@kb/core/ops/auto-sync.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import { createKBToolsRegistry } from '@kb/core/tools/kb-tools-registry.js'
import type { ChatEvent, ChatStreamFn } from './chat-types.js'
import { type QueryPipelineParams, runQueryPipeline } from './query-pipeline.js'
import { SessionStore } from './session-store.js'

export interface KbServiceOptions {
  /** Resolved absolute base directory (contains `.kb-index.sqlite`). */
  baseDir: string
  config: KbConfig
  /** Server injects chat streaming; omitted when chat is unavailable. */
  chatStream?: ChatStreamFn
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
  const { baseDir, config, bootstrapState, chatStream } = options

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
      return runQueryPipeline(
        { toolExecutor, llmProvider: llmProvider ?? undefined, baseDir, config },
        params
      )
    },

    async *chat(params) {
      if (!chatStream) {
        yield { type: 'error', message: 'chat streaming is not configured on this service' }
        return
      }
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

      for await (const event of chatStream(
        { llmProvider, toolExecutor, baseDir },
        { question: message, messages: [...history, userMessage], traceId: params.sessionId }
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
        const count = await scanBaseRepos(baseDir, { onProgress })
        if (count === 0) {
          throw new Error(
            'This base has no indexed repos to scan. Declare repos via KB_SERVER_BASE_GIT_REPOS ' +
              '(or KB_GIT_REPOS) and restart to build the index.'
          )
        }
        return `Scanned ${count} repo(s) for base "${path.basename(baseDir)}".`
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
      const indexing = bootstrapState?.indexing === true
      const bootstrapFailed = Boolean(bootstrapState?.error)
      const hasIndex = indexMtime !== undefined
      const ok = !indexing && !bootstrapFailed && hasIndex
      return {
        ok,
        base: path.basename(baseDir),
        provider: llmProvider?.name,
        model: llmProvider?.model,
        indexMtime,
        ...(indexing ? { indexing: true } : {}),
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
