import type { GroupedSource } from './source-grouping.js'

export type ChatEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'meta'; text: string }
  /** `sources` are source-centric (one entry per file, symbols folded), with blob hrefs baked in. */
  | { type: 'answer'; text: string; sources: GroupedSource[]; factsRetrieved: number }
  | { type: 'error'; message: string }
  | { type: 'done'; inputTokens?: number; outputTokens?: number }

export interface ChatStreamDeps {
  llmProvider: import('../core/types.js').LLMProvider
  toolExecutor: import('../core/tool-registry.js').ToolExecutor
  baseDir: string
}

/** Standardized structured trace hook for a chat turn. The server wires this to
 *  its logger with a per-turn `traceId`, so every decision/tool-call/answer is a
 *  greppable `chat.<action>` log line. */
export type ChatTrace = (action: string, detail?: Record<string, unknown>) => void

export interface ChatStreamParams {
  question: string
  messages: import('../core/types.js').Message[]
  /** Correlates all log lines for this turn (Slack event ts / chat session id). */
  traceId?: string
}

export type ChatStreamFn = (
  deps: ChatStreamDeps,
  params: ChatStreamParams
) => AsyncGenerator<ChatEvent>
