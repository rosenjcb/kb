import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'
import { runQueryTruthRetrieval } from './query-truth-retrieval.js'

export interface ChatQueryTruthInput {
  toolExecutor: ToolExecutor
  /** Same string `kb query` would use after optional graph expansion. */
  expandedQuery: string
  retrievalLimit: number
  workspaceDir: string
  llmProvider?: LLMProvider
  /**
   * Raw user text for this turn (before graph expansion). Passed as **`originalQuery`** so
   * answer enrichment snippets and phrasing track what the user actually asked.
   */
  userQuestion?: string
}

/** Exported for chat session answer enrichment (same envelope shape as retrieval). */
export function buildChatQueryTruthParsed(
  expandedQuery: string,
  retrievalLimit: number,
  userQuestion?: string
): ParsedIntentCommand {
  const originalQuery = userQuestion?.trim()
  return {
    envelope: {
      intent: 'query_truth',
      requestId: `req-${dayjs().valueOf()}`,
      payload: {
        query: expandedQuery,
        limit: retrievalLimit,
        ...(originalQuery ? { originalQuery } : {}),
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
  const parsed = buildChatQueryTruthParsed(
    input.expandedQuery,
    input.retrievalLimit,
    input.userQuestion
  )
  return runQueryTruthRetrieval({
    parsed,
    toolExecutor: input.toolExecutor,
    workspaceDir: input.workspaceDir,
    llmProvider: input.llmProvider,
  })
}
