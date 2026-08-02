/**
 * Bridge the CLI chat synthesis loop to a streaming event sequence.
 *
 * `runChatSynthesis` reports progress by side-effecting a `Printer` and returns
 * the final answer. We inject a printer whose output sink pushes events into an
 * async queue, then yield them as a `ChatEvent` stream — no change to the chat
 * loop itself. SSE is the transport (see http-server); WebSocket is unnecessary
 * because a turn is request-driven (one message → one streamed answer).
 */

import { describeLLMFailure } from '@kb/core/core/llm-error.js'
import { runChatSynthesis } from '@kb/core/query/chat-synthesis.js'
import { isReadFactsResult } from '@kb/core/query/intent-cli.js'
import type {
  ChatEvent,
  ChatStreamDeps,
  ChatStreamParams,
  ChatTrace,
} from '@kb/core/service/chat-types.js'
import { type QuerySource, serializeQueryResult } from '@kb/core/service/serialize.js'
import type { CliOutput } from '@kb/core/ui/cli-output.js'
import { createPrinter } from '@kb/core/ui/printer.js'
import { log } from './logger.js'

export type { ChatEvent, ChatStreamDeps, ChatStreamParams }

/**
 * Run one chat turn and yield its progress + final answer as a `ChatEvent` stream.
 * The terminal event is always `answer` then `done`, or `error`.
 */
export async function* streamChatTurn(
  deps: ChatStreamDeps,
  params: ChatStreamParams
): AsyncGenerator<ChatEvent> {
  const queue: ChatEvent[] = []
  let notify: (() => void) | undefined
  const push = (event: ChatEvent) => {
    queue.push(event)
    notify?.()
    notify = undefined
  }

  const out: CliOutput = {
    log: message => push({ type: 'meta', text: message }),
    error: message => push({ type: 'meta', text: message }),
    write: () => {},
    progress: line => {
      if (line) push({ type: 'reasoning', text: line })
    },
  }
  // 'tui' mode routes transient progress to out.progress and avoids the ora spinner.
  const printer = createPrinter(out, 'tui')

  // Standardized per-turn trace → Cloud Logging. Every routing decision, tool call,
  // and answer becomes a `chat.<action>` line correlated by traceId (the session id).
  const traceId = params.traceId ?? 'chat'
  const trace: ChatTrace = (action, detail) => log.info(`chat.${action}`, { traceId, ...detail })

  let finished = false
  let failure: Error | undefined
  let answer = ''
  let sources: QuerySource[] = []
  let factsRetrieved = 0
  let inputTokens = 0
  let outputTokens = 0

  const run = runChatSynthesis({
    question: params.question,
    messages: params.messages,
    llmProvider: deps.llmProvider,
    toolExecutor: deps.toolExecutor,
    kbStorageDir: deps.baseDir,
    printer,
    trace,
  })
    .then(result => {
      answer = result.answer
      factsRetrieved = result.factsRetrieved
      inputTokens = result.inputTokens
      outputTokens = result.outputTokens
      // A turn that produced no answer is a failure, not an empty success. Routing it to
      // the same `error` event as a thrown provider error keeps every client's existing
      // failure handling working, instead of shipping a blank `answer` event.
      if (result.failure) failure = new Error(describeLLMFailure(result.failure))
      if (result.lastIntentResult && isReadFactsResult(result.lastIntentResult)) {
        sources = serializeQueryResult(result.lastIntentResult).results
      }
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error))
    })
    .finally(() => {
      finished = true
      notify?.()
      notify = undefined
    })

  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>(resolve => {
        notify = resolve
      })
      continue
    }
    const next = queue.shift()
    if (next) yield next
  }
  await run

  if (failure) {
    yield { type: 'error', message: failure.message }
    return
  }
  yield { type: 'answer', text: answer, sources, factsRetrieved }
  yield { type: 'done', inputTokens, outputTokens }
}
