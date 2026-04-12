import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicProvider,
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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
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
})
