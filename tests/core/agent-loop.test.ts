import { describe, expect, it } from 'vitest'
import { agentLoop, runAgent } from '../../src/core/agent-loop'
import { RunCollector } from '../../src/core/telemetry'
import type { LLMProvider, LLMResponse } from '../../src/core/types'

class FakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly model = 'fake-model'
  readonly supportsStreaming = false

  constructor(private readonly responses: LLMResponse[]) {}

  async call(): Promise<LLMResponse> {
    const next = this.responses.shift()
    if (!next) {
      throw new Error('no more fake responses')
    }
    return next
  }
}

describe('agentLoop', () => {
  it('Given a provider response with no tool calls, then should emit text metadata and done in order', async () => {
    const provider = new FakeProvider([
      {
        text: 'hello',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ])

    const events = []
    for await (const event of agentLoop('hi', provider, undefined)) {
      events.push(event)
    }

    expect(events.map(e => e.type)).toEqual(['text', 'metadata', 'done'])
    expect(events[0]).toEqual({ type: 'text', content: 'hello' })
  })

  it('Given a provider response with tool calls and maxTurns one, then should emit tool events and max-turn termination', async () => {
    const provider = new FakeProvider([
      {
        text: 'calling tool',
        stopReason: 'tool_use',
        toolUses: [{ id: 'tool-1', name: 'write_document', input: { title: 'x' } }],
        usage: { inputTokens: 5, outputTokens: 8 },
      },
    ])

    const events = []
    for await (const event of agentLoop('write a doc', provider, undefined, { maxTurns: 1 })) {
      events.push(event)
    }

    expect(events.map(e => e.type)).toEqual([
      'text',
      'metadata',
      'tool_start',
      'tool_result',
      'done',
    ])

    expect(events.at(-1)).toEqual({ type: 'done', reason: 'max_turns_reached' })
  })

  it('Given runAgent wrapping agentLoop, then should return all streamed events as an array', async () => {
    const provider = new FakeProvider([
      {
        text: 'wrapped',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])

    const events = await runAgent('hello', provider, undefined)
    expect(events.length).toBe(3)
    expect(events[2]).toEqual({ type: 'done', reason: 'no_tool_calls' })
  })

  it('Given a collector, then records a stage per LLM turn with correct token counts', async () => {
    const provider = new FakeProvider([
      { text: 'hi', stopReason: 'end_turn', toolUses: [], usage: { inputTokens: 42, outputTokens: 17 } },
    ])
    const collector = new RunCollector('chat')
    const events = await runAgent('hello', provider, undefined, { collector })
    const report = collector.finish('success')
    expect(report.stages).toHaveLength(1)
    expect(report.stages[0].stage).toBe('agentLoop:turn1')
    expect(report.stages[0].inputTokens).toBe(42)
    expect(report.stages[0].outputTokens).toBe(17)
    expect(report.stages[0].provider).toBe('fake')
    expect(report.stages[0].model).toBe('fake-model')
    expect(report.totalInputTokens).toBe(42)
    expect(report.totalOutputTokens).toBe(17)
    // Sanity-check events are unaffected
    expect(events.map(e => e.type)).toEqual(['text', 'metadata', 'done'])
  })
})
