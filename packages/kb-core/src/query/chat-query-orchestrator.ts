import dayjs from 'dayjs'
import type { KbConfig } from '../config/kb-config.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'
import { runQueryTruthRetrieval } from './query-truth-retrieval.js'

export interface ChatQueryTruthInput {
  toolExecutor: ToolExecutor
  expandedQuery: string
  retrievalLimit: number
  excludeIds?: string[]
  /**
   * When set, chat retrieval runs `runQueryPipeline` (scope inference, lanes,
   * entity promotion) — the same path as `kb query`. Absent in unit tests that
   * only stub `read_facts`.
   */
  baseDir?: string
  config?: KbConfig
  llmProvider?: LLMProvider
}

function buildChatQueryTruthParsed(
  expandedQuery: string,
  retrievalLimit: number,
  excludeIds?: string[]
): ParsedIntentCommand {
  return {
    envelope: {
      intent: 'query_truth',
      requestId: `req-${dayjs().valueOf()}`,
      payload: {
        query: expandedQuery,
        limit: retrievalLimit,
        discoveryDepth: 'deep',
        surface: 'chat',
        ...(excludeIds && excludeIds.length > 0 ? { excludeIds } : {}),
      },
    },
  }
}

export async function executeChatQueryTruthRetrieval(
  input: ChatQueryTruthInput
): Promise<IntentResult> {
  if (input.baseDir) {
    const { readKbConfig } = await import('../config/kb-config.js')
    const { runQueryPipeline } = await import('../service/query-pipeline.js')
    const config = input.config ?? (await readKbConfig())
    return runQueryPipeline(
      {
        toolExecutor: input.toolExecutor,
        llmProvider: input.llmProvider,
        baseDir: input.baseDir,
        config,
      },
      { query: input.expandedQuery, synthesize: false, discovery: 'deep' }
    )
  }

  const parsed = buildChatQueryTruthParsed(
    input.expandedQuery,
    input.retrievalLimit,
    input.excludeIds
  )
  return runQueryTruthRetrieval({
    parsed,
    toolExecutor: input.toolExecutor,
  })
}
