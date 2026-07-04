import { runIntentLoop } from '@kb/core/core/intent-loop.js'
import type { RunCollector } from '@kb/core/core/telemetry.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import type { ParsedIntentCommand } from '@kb/core/query/intent-cli.js'

export interface RunQueryTruthRetrievalInput {
  /** Parsed intent after any session rewrite / graph expansion; envelope must be `query_truth`. */
  parsed: ParsedIntentCommand
  toolExecutor: ToolExecutor
  llmProvider?: LLMProvider
  /** Active KB base dir — passed to intent router. */
  kbStorageDir?: string
  collector?: RunCollector
}

/**
 * Single retrieval pipeline for **`query_truth`**: `runIntentLoop` (router → `read_facts`,
 * including shallow→deep **limit** escalation when retrieval is weak). No workspace README
 * injection. Router defaults **`discoveryDepth`** to **deep** unless the envelope sets **`--discovery shallow`**.
 *
 * **`kb query`** and chat session QUERY turns must call this only — no parallel `router.execute`
 * shortcuts — so limits and discovery escalation cannot drift.
 *
 * Future **turn router** (see `src/core/CHAT.md`): dispatch QUERY here; other intents call their
 * existing CLI handlers, then summarize for chat.
 */
export async function runQueryTruthRetrieval(
  input: RunQueryTruthRetrievalInput
): Promise<IntentResult> {
  const { result } = await runIntentLoop(input.parsed.envelope, input.toolExecutor, {
    provider: input.llmProvider,
    kbStorageDir: input.kbStorageDir,
    collector: input.collector,
  })
  return result
}
