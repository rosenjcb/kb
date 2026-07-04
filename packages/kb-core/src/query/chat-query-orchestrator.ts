import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'
import { runQueryTruthRetrieval } from './query-truth-retrieval.js'

export interface ChatQueryTruthInput {
  toolExecutor: ToolExecutor
  expandedQuery: string
  retrievalLimit: number
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

export async function executeChatQueryTruthRetrieval(
  input: ChatQueryTruthInput
): Promise<IntentResult> {
  const parsed = buildChatQueryTruthParsed(input.expandedQuery, input.retrievalLimit, input.excludeIds)
  return runQueryTruthRetrieval({
    parsed,
    toolExecutor: input.toolExecutor,
  })
}
