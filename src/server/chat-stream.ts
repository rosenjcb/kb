/**
 * Bridge the CLI chat synthesis loop to a streaming event sequence.
 *
 * `runChatSynthesis` reports progress by side-effecting a `Printer` and returns
 * the final answer. We inject a printer whose output sink pushes events into an
 * async queue, then yield them as a `ChatEvent` stream — no change to the chat
 * loop itself. SSE is the transport (see http-server); WebSocket is unnecessary
 * because a turn is request-driven (one message → one streamed answer).
 */

import type { CliOutput } from '../cli/index.js'
import { runChatSynthesis } from '../cli/chat-cli.js'
import { isReadFactsResult } from '../cli/intent-cli.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider, Message } from '../core/types.js'
import { createPrinter } from '../ui/printer.js'
import { serializeQueryResult, type QuerySource } from './serialize.js'

export type ChatEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'meta'; text: string }
  | { type: 'answer'; text: string; sources: QuerySource[]; factsRetrieved: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface ChatStreamDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  baseDir: string
}

export interface ChatStreamParams {
  question: string
  /** Full conversation history INCLUDING the current user question (chat-path contract). */
  messages: Message[]
}

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

  let finished = false
  let failure: Error | undefined
  let answer = ''
  let sources: QuerySource[] = []
  let factsRetrieved = 0

  const run = runChatSynthesis({
    question: params.question,
    messages: params.messages,
    llmProvider: deps.llmProvider,
    toolExecutor: deps.toolExecutor,
    kbStorageDir: deps.baseDir,
    printer,
  })
    .then(result => {
      answer = result.answer
      factsRetrieved = result.factsRetrieved
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
  yield { type: 'done' }
}
