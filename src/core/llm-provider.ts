/**
 * LLM Provider Abstraction
 * Normalizes different LLM APIs to a common interface
 */

import dayjs from 'dayjs'
import type {
  LLMCallParams,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  ToolResultBlock,
} from './types'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object') {
    return value as JsonRecord
  }
  return {}
}

function readApiErrorMessage(data: unknown, fallback: string): string {
  const payload = asRecord(data)
  const directError = payload.error

  if (typeof directError === 'string') {
    return directError
  }

  const nested = asRecord(directError)
  if (typeof nested.message === 'string') {
    return nested.message
  }

  if (typeof payload.message === 'string') {
    return payload.message
  }

  return fallback
}

// ─── Anthropic Claude ────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly supportsStreaming = true
  readonly model: string

  constructor(
    private apiKey: string,
    model = 'claude-3-5-sonnet-20241022'
  ) {
    this.model = model
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: params.messages.map(m => {
        if (m.role === 'user' && Array.isArray(m.content)) {
          return {
            role: 'user' as const,
            content: (m.content as ToolResultBlock[]).map(block => ({
              type: 'tool_result' as const,
              tool_use_id: block.toolUseId,
              content:
                typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
              ...(block.isError ? { is_error: true } : {}),
            })),
          }
        }
        if (m.role === 'assistant' && m.toolUses?.length) {
          const parts: unknown[] = []
          if (typeof m.content === 'string' && m.content.trim()) {
            parts.push({ type: 'text', text: m.content })
          }
          for (const tu of m.toolUses) {
            parts.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
          }
          return { role: 'assistant' as const, content: parts }
        }
        return {
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }
      }),
      tools: params.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      })),
    }

    if (params.systemPrompt) {
      body.system = params.systemPrompt
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

    const data = await response.json()
    if (!response.ok) {
      throw new Error(
        `[anthropic] API request failed (${response.status}): ${readApiErrorMessage(
          data,
          response.statusText
        )}`
      )
    }

    const payload = asRecord(data)
    const usage = asRecord(payload.usage)
    const content = Array.isArray(payload.content) ? payload.content : []

    return {
      text: this.extractText(content),
      stopReason: payload.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      toolUses: this.extractToolUses(content),
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
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

  private extractText(content: unknown[]): string {
    return content
      .map(item => asRecord(item))
      .filter(c => c.type === 'text')
      .map(c => (typeof c.text === 'string' ? c.text : ''))
      .join('')
  }

  private extractToolUses(content: unknown[]) {
    return content
      .map(item => asRecord(item))
      .filter(c => c.type === 'tool_use')
      .map(c => ({
        id: typeof c.id === 'string' ? c.id : `${dayjs().valueOf()}-tool`,
        name: typeof c.name === 'string' ? c.name : 'unknown_tool',
        input: asRecord(c.input),
      }))
  }
}

// ─── OpenAI ChatGPT ──────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  readonly supportsStreaming = true
  readonly model: string

  constructor(
    private apiKey: string,
    model = 'gpt-4-turbo'
  ) {
    this.model = model
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const systemMessages = params.systemPrompt
      ? [{ role: 'system' as const, content: params.systemPrompt }]
      : []

    const openAIMessages: Array<Record<string, unknown>> = [...systemMessages]
    for (const m of params.messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const block of m.content as ToolResultBlock[]) {
          openAIMessages.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
          })
        }
      } else if (m.role === 'assistant' && m.toolUses?.length) {
        openAIMessages.push({
          role: 'assistant',
          content: typeof m.content === 'string' && m.content ? m.content : null,
          tool_calls: m.toolUses.map(tu => ({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          })),
        })
      } else {
        openAIMessages.push({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })
      }
    }
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      messages: openAIMessages,
      tools: params.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      })),
    }

    if (params.structuredJson?.openai) {
      const { name, schema } = params.structuredJson.openai
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name,
          strict: true,
          schema,
        },
      }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(
        `[openai] API request failed (${response.status}): ${readApiErrorMessage(
          data,
          response.statusText
        )}`
      )
    }

    const payload = asRecord(data)
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const firstChoice = asRecord(choices[0])
    const message = asRecord(firstChoice.message)
    const usage = asRecord(payload.usage)
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

    return {
      text: typeof message.content === 'string' ? message.content : '',
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      toolUses: toolCalls.map((call: unknown) => {
        const toolCall = asRecord(call)
        const fn = asRecord(toolCall.function)
        return {
          id: typeof toolCall.id === 'string' ? toolCall.id : `${dayjs().valueOf()}-tool`,
          name: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
          input:
            typeof fn.arguments === 'string'
              ? (JSON.parse(fn.arguments) as Record<string, unknown>)
              : {},
        }
      }),
      usage: {
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
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

/** Gemini 2.5+ REST API accepts thinkingConfig.thinkingBudget (0 disables thinking). */
function geminiModelSupportsThinkingBudget(model: string): boolean {
  return /gemini-2\.5|gemini-3|gemini-exp/i.test(model)
}

/** Strip JSON Schema fields Gemini's function declaration API does not accept. */
function stripUnsupportedSchemaFields(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _, ...rest } = schema
  return rest
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'
  readonly supportsStreaming = true
  readonly model: string

  constructor(
    private apiKey: string,
    model = 'gemini-2.5-flash'
  ) {
    this.model = model
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const initialBudget = params.maxTokens ?? 4096
    let parsed = await this.generateContent(params, initialBudget)

    if (!parsed.text && parsed.finishReason === 'MAX_TOKENS' && initialBudget < 128) {
      parsed = await this.generateContent(params, Math.max(initialBudget * 2, 128))
    }

    return {
      text: parsed.text,
      stopReason: parsed.stopReason,
      toolUses: parsed.toolUses,
      usage: parsed.usage,
    }
  }

  async *callStream(_params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    // Gemini streaming endpoint - similar pattern
    yield { type: 'done' }
  }

  private async generateContent(
    params: LLMCallParams,
    maxOutputTokens: number
  ): Promise<{
    text: string
    stopReason: 'tool_use' | 'end_turn'
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
    usage: { inputTokens: number; outputTokens: number }
    finishReason?: string
  }> {
    const geminiContents: Array<Record<string, unknown>> = []
    for (const m of params.messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        geminiContents.push({
          role: 'user',
          parts: (m.content as ToolResultBlock[]).map(block => ({
            functionResponse: {
              name: block.toolName,
              response: {
                result:
                  typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
              },
            },
          })),
        })
      } else if (m.role === 'assistant' && m.toolUses?.length) {
        const parts: unknown[] = []
        if (typeof m.content === 'string' && m.content.trim()) {
          parts.push({ text: m.content })
        }
        for (const tu of m.toolUses) {
          parts.push({ functionCall: { name: tu.name, args: tu.input } })
        }
        geminiContents.push({ role: 'model', parts })
      } else {
        geminiContents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        })
      }
    }
    const body = {
      contents: geminiContents,
      ...(params.systemPrompt
        ? {
            system_instruction: {
              parts: [{ text: params.systemPrompt }],
            },
          }
        : {}),
      tools: params.tools?.map(t => ({
        functionDeclarations: [
          {
            name: t.name,
            description: t.description,
            parameters: stripUnsupportedSchemaFields(t.schema),
          },
        ],
      })),
      generationConfig: {
        maxOutputTokens,
        temperature: params.temperature ?? 0.7,
        ...(params.thinkingBudget !== undefined && geminiModelSupportsThinkingBudget(this.model)
          ? { thinkingConfig: { thinkingBudget: params.thinkingBudget } }
          : {}),
        ...(params.structuredJson?.gemini
          ? {
              responseMimeType: 'application/json',
              responseSchema: params.structuredJson.gemini,
            }
          : {}),
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

    const data = await response.json()
    if (!response.ok) {
      throw new Error(
        `[gemini] API request failed (${response.status}): ${readApiErrorMessage(
          data,
          response.statusText
        )}`
      )
    }

    const payload = asRecord(data)
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    const first = asRecord(candidates[0])
    const contentRecord = asRecord(first.content)
    const content = Array.isArray(contentRecord.parts) ? contentRecord.parts : []
    const usage = asRecord(payload.usageMetadata)

    return {
      text: content
        .map((p: unknown) => asRecord(p))
        .filter(p => typeof p.text === 'string' && p.text.length > 0)
        // Gemini 2.5+ may emit reasoning in separate parts with thought: true.
        .filter(p => p.thought !== true)
        .map(p => String(p.text))
        .join(''),
      stopReason: content.some((p: unknown) => asRecord(p).functionCall) ? 'tool_use' : 'end_turn',
      toolUses: content
        .map((p: unknown) => asRecord(p))
        .filter(p => p.functionCall)
        .map(p => {
          const call = asRecord(p.functionCall)
          return {
            id: `${dayjs().valueOf()}-${Math.random()}`,
            name: typeof call.name === 'string' ? call.name : 'unknown_tool',
            input: asRecord(call.args),
          }
        }),
      usage: {
        inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
        outputTokens:
          typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0,
      },
      finishReason: typeof first.finishReason === 'string' ? first.finishReason : undefined,
    }
  }
}

// ─── Local Ollama ───────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama'
  readonly supportsStreaming = true
  readonly model: string

  constructor(
    private endpoint = 'http://localhost:11434',
    model = 'mistral'
  ) {
    this.model = model
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: params.messages,
        ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
        stream: false,
      }),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(
        `[ollama] API request failed (${response.status}): ${readApiErrorMessage(
          data,
          response.statusText
        )}`
      )
    }

    const payload = asRecord(data)
    const message = asRecord(payload.message)

    return {
      text: typeof message.content === 'string' ? message.content : '',
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
    case 'anthropic': {
      const key = config.apiKey
      if (!key) throw new Error('Anthropic provider requires apiKey')
      return new AnthropicProvider(key, config.model)
    }
    case 'openai': {
      const key = config.apiKey
      if (!key) throw new Error('OpenAI provider requires apiKey')
      return new OpenAIProvider(key, config.model)
    }
    case 'gemini': {
      const key = config.apiKey
      if (!key) throw new Error('Gemini provider requires apiKey')
      return new GeminiProvider(key, config.model)
    }
    case 'ollama':
      return new OllamaProvider(config.endpoint, config.model)
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}
