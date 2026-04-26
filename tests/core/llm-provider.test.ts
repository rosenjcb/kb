import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  createProvider,
} from '../../src/core/llm-provider'

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
})
