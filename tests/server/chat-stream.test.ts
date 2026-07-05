import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import { type ChatEvent, streamChatTurn } from '@kb/server/chat-stream.js'

const emptyToolExecutor: ToolExecutor = {
  getTools: () => [],
  execute: async () => ({}),
  register: () => {},
}

function fakeProvider(answer: string, opts: { fail?: boolean } = {}): LLMProvider {
  return {
    name: 'fake',
    model: 'fake',
    supportsStreaming: false,
    async call(params) {
      if (opts.fail) throw new Error('provider boom')
      params.onReasoning?.('reasoning tokens')
      return {
        text: answer,
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 4, outputTokens: 2 },
      }
    },
  }
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

describe('streamChatTurn', () => {
                it('[TC-1] streams reasoning then a terminal answer and done', async () => {
    const events = await collect(
      streamChatTurn(
        { llmProvider: fakeProvider('The answer.'), toolExecutor: emptyToolExecutor, baseDir: '/tmp/none' },
        { question: 'hi', messages: [{ role: 'user', content: 'hi' }] }
      )
    )

    expect(events.some(e => e.type === 'reasoning')).toBe(true)
    const answer = events.find(e => e.type === 'answer')
    expect(answer).toBeDefined()
    if (answer?.type === 'answer') expect(answer.text).toBe('The answer.')
    expect(events.at(-1)).toEqual({ type: 'done', inputTokens: 4, outputTokens: 2 })
  })

                it('[TC-2] emits an error event when synthesis throws', async () => {
    const events = await collect(
      streamChatTurn(
        { llmProvider: fakeProvider('', { fail: true }), toolExecutor: emptyToolExecutor, baseDir: '/tmp/none' },
        { question: 'hi', messages: [{ role: 'user', content: 'hi' }] }
      )
    )
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.message).toContain('boom')
  })
})
