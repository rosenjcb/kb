/**
 * LLM Provider Abstraction
 * Normalizes different LLM APIs to a common interface
 */

import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMCallParams,
} from './types'

// ─── Anthropic Claude ────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly supportsStreaming = true

  constructor(
    private apiKey: string,
    private model: string = 'claude-3-5-sonnet-20241022'
  ) {}

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      tools: params.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      })),
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    const data = (await response.json()) as any

    return {
      text: this.extractText(data.content),
      stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      toolUses: this.extractToolUses(data.content),
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    }
  }

  async *callStream(params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: params.messages,
      tools: params.tools,
      stream: true,
    }

    const response = await fetch('https://api.anthropic.com/v1/messages/stream', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    while (reader) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          const event = JSON.parse(line.slice(5))

          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', content: event.delta.text }
            }
          }
        }
      }
    }
  }

  private extractText(content: any[]): string {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')
  }

  private extractToolUses(content: any[]) {
    return content
      .filter(c => c.type === 'tool_use')
      .map(c => ({
        id: c.id,
        name: c.name,
        input: c.input,
      }))
  }
}

// ─── OpenAI ChatGPT ──────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  readonly supportsStreaming = true

  constructor(
    private apiKey: string,
    private model: string = 'gpt-4-turbo'
  ) {}

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      messages: params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      tools: params.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      })),
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = (await response.json()) as any
    const message = data.choices[0].message

    return {
      text: message.content || '',
      stopReason: message.tool_calls ? 'tool_use' : 'end_turn',
      toolUses: (message.tool_calls || []).map(call => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      })),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    }
  }

  async *callStream(params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    const body = {
      model: this.model,
      messages: params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      tools: params.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      })),
      stream: true,
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    while (reader) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value)
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') continue

          const data = JSON.parse(dataStr)
          const delta = data.choices?.[0]?.delta

          if (delta?.content) {
            yield { type: 'text_delta', content: delta.content }
          }
        }
      }
    }
  }
}

// ─── Google Gemini ──────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'
  readonly supportsStreaming = true

  constructor(
    private apiKey: string,
    private model: string = 'gemini-2.0-flash'
  ) {}

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const body = {
      contents: params.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      })),
      tools: params.tools?.map(t => ({
        functionDeclarations: [
          {
            name: t.name,
            description: t.description,
            parameters: t.schema,
          },
        ],
      })),
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0.7,
      },
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    const data = (await response.json()) as any
    const content = data.candidates?.[0]?.content?.parts || []

    return {
      text: content
        .filter(p => p.text)
        .map(p => p.text)
        .join(''),
      stopReason: content.some(p => p.functionCall) ? 'tool_use' : 'end_turn',
      toolUses: content
        .filter(p => p.functionCall)
        .map(p => ({
          id: `${Date.now()}-${Math.random()}`,
          name: p.functionCall.name,
          input: p.functionCall.args || {},
        })),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
    }
  }

  async *callStream(_params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    // Gemini streaming endpoint - similar pattern
    yield { type: 'done' }
  }
}

// ─── Local Ollama ───────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama'
  readonly supportsStreaming = true

  constructor(
    private endpoint: string = 'http://localhost:11434',
    private model: string = 'mistral'
  ) {}

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: params.messages,
        stream: false,
      }),
    })

    const data = (await response.json()) as any

    return {
      text: data.message.content,
      stopReason: 'end_turn',
      toolUses: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    }
  }

  async *callStream(params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: params.messages,
        stream: true,
      }),
    })

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    while (reader) {
      const { done, value } = await reader.read()
      if (done) break

      const lines = decoder.decode(value).split('\n')
      for (const line of lines) {
        if (line) {
          const chunk = JSON.parse(line)
          if (chunk.message?.content) {
            yield { type: 'text_delta', content: chunk.message.content }
          }
        }
      }
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createProvider(config: {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey?: string
  endpoint?: string
  model?: string
}): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config.apiKey!, config.model)
    case 'openai':
      return new OpenAIProvider(config.apiKey!, config.model)
    case 'gemini':
      return new GeminiProvider(config.apiKey!, config.model)
    case 'ollama':
      return new OllamaProvider(config.endpoint, config.model)
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}
