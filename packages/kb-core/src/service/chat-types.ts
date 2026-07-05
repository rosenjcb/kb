import type { QuerySource } from './serialize.js'

export type ChatEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'meta'; text: string }
  | { type: 'answer'; text: string; sources: QuerySource[]; factsRetrieved: number }
  | { type: 'error'; message: string }
  | { type: 'done'; inputTokens?: number; outputTokens?: number }

export interface ChatStreamDeps {
  llmProvider: import('../core/types.js').LLMProvider
  toolExecutor: import('../core/tool-registry.js').ToolExecutor
  baseDir: string
}

export interface ChatStreamParams {
  question: string
  messages: import('../core/types.js').Message[]
}

export type ChatStreamFn = (
  deps: ChatStreamDeps,
  params: ChatStreamParams,
) => AsyncGenerator<ChatEvent>
