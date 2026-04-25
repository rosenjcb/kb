import { runIntentLoop } from '../core/intent-loop.js'
import type { RunCollector } from '../core/telemetry.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import {
  type ParsedIntentCommand,
  augmentIntentResultWithWorkspaceFallback,
  isReadDocumentsResult,
  resolveReadDocumentsAnswerForQuestion,
} from './intent-cli.js'
import { runQueryTruthRetrievalOmp } from './query-truth-omp-retrieval.js'

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
 * When **`llmProvider`** is set, retrieval first uses an **Oh My Pi** in-memory agent that may call
 * **`read_documents`** up to a small fixed budget, then falls back to the legacy **`runIntentLoop`**
 * path if OMP does not produce usable hits (keeps CI and edge environments working).
 *
 * Future **turn router** (see `src/core/CHAT.md`): dispatch QUERY here; other intents call their
 * existing CLI handlers, then summarize for chat.
 */
export async function runQueryTruthRetrieval(
  input: RunQueryTruthRetrievalInput
): Promise<IntentResult> {
  if (input.llmProvider) {
    try {
      const ompResult = await runQueryTruthRetrievalOmp({
        parsed: input.parsed,
        toolExecutor: input.toolExecutor,
        workspaceDir: input.workspaceDir,
        llmProvider: input.llmProvider,
        collector: input.collector,
      })
      if (isReadDocumentsResult(ompResult)) {
        return await finalizeQueryTruthRetrieval(input, ompResult)
      }
    } catch {
      // Fall through to legacy intent loop.
    }
  }

  const { result } = await runIntentLoop(input.parsed.envelope, input.toolExecutor, {
    provider: input.llmProvider,
    collector: input.collector,
  })
  return finalizeQueryTruthRetrieval(input, result)
}

async function finalizeQueryTruthRetrieval(
  input: RunQueryTruthRetrievalInput,
  result: IntentResult
): Promise<IntentResult> {
  const augmented = await augmentIntentResultWithWorkspaceFallback(
    input.parsed,
    result,
    input.workspaceDir
  )
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
