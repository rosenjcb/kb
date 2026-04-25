/**
 * LLM Provider Abstraction
 * Normalizes different LLM APIs to a common interface
 */

import dayjs from 'dayjs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMCallParams, LLMProvider, LLMResponse, LLMStreamChunk } from './types'

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

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      messages: [
        ...systemMessages,
        ...params.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      ],
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
    const body = {
      contents: params.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      })),
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
            parameters: t.schema,
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

class OmpSessionProvider implements LLMProvider {
  readonly supportsStreaming = false

  constructor(
    readonly name: 'anthropic' | 'openai' | 'gemini' | 'ollama',
    readonly model: string,
    private readonly apiKey?: string,
    private readonly endpoint?: string
  ) {}

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const text = await runPromptViaBun({
      cwd: process.cwd(),
      provider: this.name,
      model: this.model,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      systemPrompt: params.systemPrompt,
      messages: params.messages.map(message => ({
        role: message.role,
        content:
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      })),
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    })
    return {
      text,
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

async function runPromptViaBun(options: {
  cwd: string
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  model: string
  apiKey?: string
  endpoint?: string
  systemPrompt?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
}): Promise<string> {
  const payload = JSON.stringify(options)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidatePaths = [
    path.join(here, 'omp-bun-bridge.ts'),
    path.join(here, '../../src/core/omp-bun-bridge.ts'),
  ]
  const bridgePath = candidatePaths.find(p => existsSync(p))
  if (!bridgePath) {
    throw new Error(`OMP Bun bridge not found (checked: ${candidatePaths.join(', ')})`)
  }
  const proc = spawn('bun', [bridgePath], { cwd: options.cwd, stdio: 'pipe' })

  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  proc.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) {
    throw new Error(`OMP Bun bridge failed: ${stderr.trim() || `exit code ${exitCode}`}`)
  }
  const parsed = JSON.parse(stdout) as { text?: string }
  return parsed.text ?? ''
}

export function createProvider(config: {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey?: string
  endpoint?: string
  model?: string
}): LLMProvider {
  if (config.provider === 'anthropic') {
    const key = config.apiKey
    if (!key) throw new Error('Anthropic provider requires apiKey')
    return new OmpSessionProvider('anthropic', config.model ?? 'claude-3-5-sonnet', key)
  }
  if (config.provider === 'openai') {
    const key = config.apiKey
    if (!key) throw new Error('OpenAI provider requires apiKey')
    return new OmpSessionProvider('openai', config.model ?? 'gpt-4o', key)
  }
  if (config.provider === 'gemini') {
    const key = config.apiKey
    if (!key) throw new Error('Gemini provider requires apiKey')
    return new OmpSessionProvider('gemini', config.model ?? 'gemini-2.5-flash', key)
  }
  if (config.provider === 'ollama') {
    const endpoint = config.endpoint ?? 'http://localhost:11434'
    return new OmpSessionProvider('ollama', config.model ?? 'qwen3:8b', undefined, endpoint)
  }
  throw new Error(`Unknown provider: ${config.provider}`)
}
