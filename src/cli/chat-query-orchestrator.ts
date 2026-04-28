import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'
import { runQueryTruthRetrieval } from './query-truth-retrieval.js'

export interface ChatQueryTruthInput {
  toolExecutor: ToolExecutor
  /** Same string `kb query` would use after optional graph expansion. */
  expandedQuery: string
  retrievalLimit: number
  workspaceDir: string
}

function buildChatQueryTruthParsed(
  expandedQuery: string,
  retrievalLimit: number
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
      },
    },
    output: 'human',
  }
}

/**
 * Chat QUERY branch: builds the same **`query_truth`** shape as CLI `kb query`, then
 * **`runQueryTruthRetrieval()`** (intent loop + workspace augment). Thin adapter only.
 */
export async function executeChatQueryTruthRetrieval(
  input: ChatQueryTruthInput
): Promise<IntentResult> {
  const parsed = buildChatQueryTruthParsed(input.expandedQuery, input.retrievalLimit)
  return runQueryTruthRetrieval({
    parsed,
    toolExecutor: input.toolExecutor,
    workspaceDir: input.workspaceDir,
  })
}
