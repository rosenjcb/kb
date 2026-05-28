import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'
import { runQueryTruthRetrieval } from './query-truth-retrieval.js'

export interface ChatQueryTruthInput {
  toolExecutor: ToolExecutor
  /** Same string `kb query` would use after graph-augmented query expansion. */
  expandedQuery: string
  retrievalLimit: number
  /** Fact IDs already accumulated in the session pool — orchestrator skips these. */
  excludeIds?: string[]
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

/**
 * Chat QUERY branch: builds the same **`query_truth`** shape as CLI `kb query`, then
 * **`runQueryTruthRetrieval()`** (intent loop only). Thin adapter only.
 */
export async function executeChatQueryTruthRetrieval(
  input: ChatQueryTruthInput
): Promise<IntentResult> {
  const parsed = buildChatQueryTruthParsed(input.expandedQuery, input.retrievalLimit, input.excludeIds)
  return runQueryTruthRetrieval({
    parsed,
    toolExecutor: input.toolExecutor,
  })
}
