import { runIntentLoop } from '../core/intent-loop.js'
import type { RunCollector } from '../core/telemetry.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import {
  augmentIntentResultWithWorkspaceFallback,
  isReadDocumentsResult,
  resolveReadDocumentsAnswerForQuestion,
  type ParsedIntentCommand,
} from './intent-cli.js'

export interface RunQueryTruthRetrievalInput {
  /** Parsed intent after any session rewrite / graph expansion; envelope must be `query_truth`. */
  parsed: ParsedIntentCommand
  toolExecutor: ToolExecutor
  /** Project root for workspace README / GAMEPLAN fallback (same as CLI `kb query`). */
  workspaceDir: string
  llmProvider?: LLMProvider
  collector?: RunCollector
}

/**
 * Single retrieval pipeline for **`query_truth`**: `runIntentLoop` (router → `read_documents`,
 * including shallow→deep **limit** escalation when retrieval is weak) then
 * `augmentIntentResultWithWorkspaceFallback`. Router defaults **`discoveryDepth`** to **deep**
 * unless the envelope sets **`--discovery shallow`** via CLI flags.
 *
 * **`kb query`** and **`kb chat`** QUERY turns must call this only — no parallel `router.execute`
 * shortcuts — so limits, discovery escalation, and augment behavior cannot drift.
 *
 * Future **turn router** (see `src/core/CHAT.md`): dispatch QUERY here; other intents call their
 * existing CLI handlers, then summarize for chat.
 */
export async function runQueryTruthRetrieval(
  input: RunQueryTruthRetrievalInput
): Promise<IntentResult> {
  const { result } = await runIntentLoop(input.parsed.envelope, input.toolExecutor, {
    provider: input.llmProvider,
    collector: input.collector,
  })
  const augmented = await augmentIntentResultWithWorkspaceFallback(input.parsed, result, input.workspaceDir)
  if (!isReadDocumentsResult(augmented)) return augmented

  const payload = input.parsed.envelope.payload
  const question =
    (typeof payload.originalQuery === 'string' ? payload.originalQuery : undefined) ??
    (typeof payload.query === 'string' ? payload.query : undefined) ??
    ''
  if (!question.trim()) return augmented

  const answer = resolveReadDocumentsAnswerForQuestion(augmented, question)
  if (!answer) return augmented

  return {
    ...augmented,
    data: {
      ...(augmented.data ?? {}),
      answer,
    },
  }
}
