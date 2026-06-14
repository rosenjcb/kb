import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  createProvider,
} from '../../src/core/llm-provider'

/** Build a streaming fetch Response whose body emits the given text chunks. */
function streamResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

describe('llm-provider', () => {
  it('Given each provider name in factory config, then should return a provider with matching name', () => {
    expect(createProvider({ provider: 'anthropic', apiKey: 'k' }).name).toBe('anthropic')
    expect(createProvider({ provider: 'openai', apiKey: 'k' }).name).toBe('openai')
    expect(createProvider({ provider: 'gemini', apiKey: 'k' }).name).toBe('gemini')
    expect(createProvider({ provider: 'ollama', endpoint: 'http://localhost:11434' }).name).toBe(
      'ollama'
    )
  })

  it('Given an anthropic non-ok response, then should throw a readable api error instead of crashing on undefined content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      })
    )

    const provider = new AnthropicProvider('bad-key')

    await expect(
      provider.call({
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow('[anthropic] API request failed (401): invalid key')

    fetchMock.mockRestore()
  })

  it('Given an openai malformed but successful payload, then should return safe defaults rather than throw', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const provider = new OpenAIProvider('test-key')

    const result = await provider.call({
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.text).toBe('')
    expect(result.toolUses).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })

    fetchMock.mockRestore()
  })

  it('Given a custom Gemini model, then provider calls the matching model endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    const provider = new GeminiProvider('test-key', 'gemini-flash-latest')
    await provider.call({
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/models/gemini-flash-latest:generateContent?key=test-key'),
      expect.any(Object)
    )

    fetchMock.mockRestore()
  })

  it('Given a Gemini system prompt and assistant history, then provider sends system_instruction and model-role contents', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    const provider = new GeminiProvider('test-key', 'gemini-flash-latest')
    await provider.call({
      systemPrompt: 'You are KB.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    })

    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'))
    expect(body.system_instruction?.parts?.[0]?.text).toBe('You are KB.')
    expect(body.contents?.[0]?.role).toBe('user')
    expect(body.contents?.[1]?.role).toBe('model')

    fetchMock.mockRestore()
  })

  it('Given thinkingBudget 0 on a Gemini 2.5 model, then generationConfig includes thinkingConfig', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
          usageMetadata: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')
    await provider.call({
      messages: [{ role: 'user', content: 'x' }],
      thinkingBudget: 0,
    })

    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'))
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0)

    fetchMock.mockRestore()
  })

  it('Given Gemini parts with thought true, then visible text excludes reasoning parts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'internal reasoning', thought: true }, { text: 'ANSWER' }],
              },
            },
          ],
          usageMetadata: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')
    const result = await provider.call({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.text).toBe('ANSWER')

    fetchMock.mockRestore()
  })

  it('Given Gemini preview uses the first small token budget on thoughts only, then provider retries once with a larger budget and returns visible text', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'GEMINI_OK' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )

    const provider = new GeminiProvider('test-key', 'gemini-flash-latest')
    const result = await provider.call({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 16,
    })

    expect(result.text).toBe('GEMINI_OK')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockRestore()
  })

  describe('reasoning streaming (onReasoning)', () => {
    it('Given an Anthropic onReasoning callback, then thinking enabled, deltas streamed, and text/usage reconstructed', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        streamResponse([
          sse({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
          sse({ type: 'message_stop' }),
        ])
      )

      const reasoning: string[] = []
      const provider = new AnthropicProvider('k', 'claude-haiku-4-5')
      const result = await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
        onReasoning: d => reasoning.push(d),
      })

      expect(result.text).toBe('Hello')
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
      expect(reasoning.join('')).toBe('let me reason')

      const [, init] = fetchMock.mock.calls[0] ?? []
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'))
      expect(body.stream).toBe(true)
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })

      fetchMock.mockRestore()
    })

    it('Given an Anthropic streamed tool_use, then input JSON deltas reconstruct the tool call', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        streamResponse([
          sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'query_kb' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"facts"}' } }),
          sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
          sse({ type: 'message_stop' }),
        ])
      )

      const provider = new AnthropicProvider('k', 'claude-haiku-4-5')
      const result = await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
        onReasoning: () => {},
      })

      expect(result.stopReason).toBe('tool_use')
      expect(result.toolUses).toEqual([{ id: 'tu_1', name: 'query_kb', input: { q: 'facts' } }])

      fetchMock.mockRestore()
    })

    it('Given an Anthropic stream that errors, then call falls back to the non-streaming path', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(streamResponse(['nope'], 500))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'FALLBACK' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )

      const reasoning: string[] = []
      const provider = new AnthropicProvider('k', 'claude-haiku-4-5')
      const result = await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
        onReasoning: d => reasoning.push(d),
      })

      expect(result.text).toBe('FALLBACK')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(reasoning).toEqual([])

      fetchMock.mockRestore()
    })

    it('Given an OpenAI reasoning stream, then reasoning deltas and tool calls reconstruct', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        streamResponse([
          sse({ choices: [{ delta: { reasoning: 'thinking…' } }] }),
          sse({ choices: [{ delta: { content: 'partial ' } }] }),
          sse({ choices: [{ delta: { content: 'answer' } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'query_kb', arguments: '{"q":' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
          sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 4 } }),
        ])
      )

      const reasoning: string[] = []
      const provider = new OpenAIProvider('k', 'gpt-5')
      const result = await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
        onReasoning: d => reasoning.push(d),
      })

      expect(reasoning.join('')).toBe('thinking…')
      expect(result.text).toBe('partial answer')
      expect(result.stopReason).toBe('tool_use')
      expect(result.toolUses).toEqual([{ id: 'c1', name: 'query_kb', input: { q: 'x' } }])
      expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 4 })

      fetchMock.mockRestore()
    })

    it('Given a Gemini onReasoning callback, then thought parts stream and visible text/tools reconstruct', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        streamResponse([
          sse({ candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] }),
          sse({ candidates: [{ content: { parts: [{ text: 'ANSWER' }] } }] }),
          sse({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }),
        ])
      )

      const reasoning: string[] = []
      const provider = new GeminiProvider('k', 'gemini-2.5-flash')
      const result = await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
        onReasoning: d => reasoning.push(d),
      })

      expect(reasoning.join('')).toBe('pondering')
      expect(result.text).toBe('ANSWER')
      expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 2 })

      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(String(url)).toContain(':streamGenerateContent?alt=sse')
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'))
      expect(body.generationConfig?.thinkingConfig?.includeThoughts).toBe(true)

      fetchMock.mockRestore()
    })
  })
})
