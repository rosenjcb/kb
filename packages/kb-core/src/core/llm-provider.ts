/**
 * LLM Provider Abstraction
 * Normalizes different LLM APIs to a common interface
 */

import dayjs from 'dayjs'
import { LLMApiError, classifyProviderStatus } from './llm-error.js'
import type {
  LLMCallParams,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  ToolResultBlock,
} from './types'

type JsonRecord = Record<string, unknown>

/**
 * Default thinking / reasoning budget (tokens) when a caller opts into reasoning
 * ({@link LLMCallParams.onReasoning} / Gemini `includeThoughts`) without an
 * explicit {@link LLMCallParams.thinkingBudget}.
 *
 * Also the fallback for {@link resolveGeminiThinkingBudget} when
 * `GEMINI_THINKING_BUDGET` is unset. Never omit `thinkingConfig` on Gemini 2.5/3
 * — an omitted budget means unbounded dynamic thinking.
 */
export const DEFAULT_GEMINI_THINKING_BUDGET = 1024

/**
 * Resolve Gemini `thinkingConfig.thinkingBudget` for every generateContent call.
 *
 * Priority:
 * 1. Explicit `thinkingBudget` on the call (including `0` to disable)
 * 2. `GEMINI_THINKING_BUDGET` env (global override for any Gemini client user)
 * 3. Mode default — {@link DEFAULT_GEMINI_THINKING_BUDGET} when thinking is on
 *    (`includeThoughts` / onReasoning), otherwise `0` (thinking off)
 */
export function resolveGeminiThinkingBudget(
  thinkingBudget: number | undefined,
  opts: { includeThoughts?: boolean } = {}
): number {
  if (typeof thinkingBudget === 'number' && Number.isFinite(thinkingBudget)) {
    return Math.max(0, Math.floor(thinkingBudget))
  }
  const raw = process.env.GEMINI_THINKING_BUDGET?.trim()
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return opts.includeThoughts ? DEFAULT_GEMINI_THINKING_BUDGET : 0
}
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

/**
 * Build a classified {@link LLMApiError} for a non-2xx provider response.
 *
 * Every provider funnels through here so callers can branch on `kind`
 * (`rate_limit`, `insufficient_credits`, `auth`, …) instead of pattern-matching
 * a message string. The message keeps its historical
 * `[provider] API request failed (NNN): …` shape so logs stay recognizable.
 */
function providerApiError(
  providerLabel: string,
  response: Pick<Response, 'status' | 'statusText'>,
  data: unknown
): LLMApiError {
  const detail = readApiErrorMessage(data, response.statusText)
  return new LLMApiError({
    provider: providerLabel,
    kind: classifyProviderStatus(response.status, detail),
    message: `[${providerLabel}] API request failed (${response.status}): ${detail}`,
    status: response.status,
    detail,
  })
}

/** Resolve the reasoning budget for a reasoning-enabled (non-Gemini) call. */
function resolveReasoningBudget(params: LLMCallParams): number {
  if (typeof params.thinkingBudget === 'number' && params.thinkingBudget > 0) {
    return params.thinkingBudget
  }
  return DEFAULT_GEMINI_THINKING_BUDGET
}

/**
 * Stream Server-Sent-Event `data:` payloads from a fetch Response, parsed as JSON.
 * Lines are buffered across chunk boundaries so multi-chunk events parse correctly.
 * Throws a readable error for non-2xx responses (mirrors the non-streaming paths).
 */
async function* iterateSseData(
  response: Response,
  providerLabel: string
): AsyncGenerator<JsonRecord> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw providerApiError(providerLabel, response, data)
  }

  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = function* (raw: string): Generator<JsonRecord> {
    const line = raw.trim()
    if (!line || line.startsWith(':')) return
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      yield asRecord(JSON.parse(payload))
    } catch {
      // Ignore malformed/partial events.
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      yield* emit(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  if (buffer) yield* emit(buffer)
}

/**
 * Stream newline-delimited JSON objects (JSONL) from a fetch Response.
 * Used by providers that stream JSONL rather than SSE (e.g. Ollama).
 */
async function* iterateJsonLines(
  response: Response,
  providerLabel: string
): AsyncGenerator<JsonRecord> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw providerApiError(providerLabel, response, data)
  }

  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = function* (raw: string): Generator<JsonRecord> {
    const line = raw.trim()
    if (!line) return
    try {
      yield asRecord(JSON.parse(line))
    } catch {
      // Ignore malformed/partial lines.
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      yield* emit(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  if (buffer) yield* emit(buffer)
}

// ─── Anthropic Claude ────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly supportsStreaming = true
  readonly model: string

  constructor(
    private apiKey: string,
    model = 'claude-haiku-4-5'
  ) {
    this.model = model
  }

  /** Map the unified message list to Anthropic's content-block format. */
  private buildMessages(params: LLMCallParams): unknown[] {
    return params.messages.map(m => {
      if (m.role === 'user' && Array.isArray(m.content)) {
        return {
          role: 'user' as const,
          content: (m.content as ToolResultBlock[]).map(block => ({
            type: 'tool_result' as const,
            tool_use_id: block.toolUseId,
            content: typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
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
    })
  }

  private buildTools(params: LLMCallParams) {
    return params.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }))
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    if (params.onReasoning) {
      try {
        return await this.callWithReasoning(params, params.onReasoning)
      } catch {
        // Reasoning stream unsupported/failed for this model — fall back transparently.
      }
    }
    return this.callNonStreaming(params)
  }

  private async callNonStreaming(params: LLMCallParams): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: this.buildMessages(params),
      tools: this.buildTools(params),
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
      throw providerApiError('anthropic', response, data)
    }

    const payload = asRecord(data)
    const usage = asRecord(payload.usage)
    const content = Array.isArray(payload.content) ? payload.content : []

    return {
      text: this.extractText(content),
      stopReason: payload.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      toolUses: this.extractToolUses(content),
      // Anthropic's output_tokens already includes extended-thinking tokens.
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      },
    }
  }

  /**
   * Streaming call with extended thinking enabled. Forwards `thinking_delta` events to
   * `onReasoning` and reconstructs the full {@link LLMResponse} from the SSE stream.
   */
  private async callWithReasoning(
    params: LLMCallParams,
    onReasoning: (delta: string) => void
  ): Promise<LLMResponse> {
    const budget = resolveReasoningBudget(params)
    // Extended thinking requires max_tokens > budget_tokens.
    const maxTokens = Math.max(params.maxTokens ?? 4096, budget + 512)

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: this.buildMessages(params),
      tools: this.buildTools(params),
      thinking: { type: 'enabled', budget_tokens: budget },
      stream: true,
      // Extended thinking does not allow a custom temperature; omit it.
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

    let text = ''
    let stopReason: LLMResponse['stopReason'] = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    // tool_use blocks arrive incrementally as input_json_delta keyed by content index.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()

    for await (const event of iterateSseData(response, 'anthropic')) {
      const type = event.type
      if (type === 'message_start') {
        const usage = asRecord(asRecord(event.message).usage)
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
      } else if (type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : -1
        const block = asRecord(event.content_block)
        if (block.type === 'tool_use') {
          toolBlocks.set(index, {
            id: typeof block.id === 'string' ? block.id : `${dayjs().valueOf()}-tool`,
            name: typeof block.name === 'string' ? block.name : 'unknown_tool',
            json: '',
          })
        }
      } else if (type === 'content_block_delta') {
        const delta = asRecord(event.delta)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          onReasoning(delta.thinking)
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = typeof event.index === 'number' ? event.index : -1
          const tb = toolBlocks.get(index)
          if (tb) tb.json += delta.partial_json
        }
      } else if (type === 'message_delta') {
        const delta = asRecord(event.delta)
        if (delta.stop_reason === 'tool_use') stopReason = 'tool_use'
        const usage = asRecord(event.usage)
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
      }
    }

    const toolUses = [...toolBlocks.values()].map(tb => ({
      id: tb.id,
      name: tb.name,
      input: this.parseToolJson(tb.json),
    }))
    if (toolUses.length > 0) stopReason = 'tool_use'

    return {
      text,
      stopReason,
      toolUses,
      usage: { inputTokens, outputTokens },
    }
  }

  private parseToolJson(json: string): Record<string, unknown> {
    if (!json.trim()) return {}
    try {
      return asRecord(JSON.parse(json))
    } catch {
      return {}
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
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'reasoning_delta', content: event.delta.thinking }
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

  /** Map the unified message list to OpenAI chat-completions format. */
  private buildMessages(params: LLMCallParams): Array<Record<string, unknown>> {
    const openAIMessages: Array<Record<string, unknown>> = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }]
      : []
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
    return openAIMessages
  }

  private buildTools(params: LLMCallParams) {
    return params.tools?.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }))
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    // Native structured JSON is incompatible with the streaming reconstruction path.
    if (params.onReasoning && !params.structuredJson?.openai) {
      try {
        return await this.callWithReasoning(params, params.onReasoning)
      } catch {
        // Fall back transparently if streaming fails.
      }
    }
    return this.callNonStreaming(params)
  }

  private async callNonStreaming(params: LLMCallParams): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      messages: this.buildMessages(params),
      tools: this.buildTools(params),
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
      throw providerApiError('openai', response, data)
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
      // OpenAI completion_tokens already includes reasoning tokens (details.reasoning_tokens
      // is a breakdown only — do not add it again).
      usage: {
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      },
    }
  }

  /**
   * Streaming call that forwards reasoning deltas (`delta.reasoning` /
   * `delta.reasoning_content`, emitted by reasoning-capable models) to `onReasoning`
   * and reconstructs the full {@link LLMResponse} including tool calls and usage.
   */
  private async callWithReasoning(
    params: LLMCallParams,
    onReasoning: (delta: string) => void
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      messages: this.buildMessages(params),
      tools: this.buildTools(params),
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let sawToolCalls = false
    // Tool calls stream as index-keyed deltas (name once, arguments incrementally).
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    for await (const event of iterateSseData(response, 'openai')) {
      const usage = asRecord(event.usage)
      if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens

      const choices = Array.isArray(event.choices) ? event.choices : []
      const delta = asRecord(asRecord(choices[0]).delta)
      if (typeof delta.content === 'string') text += delta.content
      const reasoning =
        typeof delta.reasoning === 'string'
          ? delta.reasoning
          : typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : ''
      if (reasoning) onReasoning(reasoning)

      const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const raw of deltaToolCalls) {
        sawToolCalls = true
        const tc = asRecord(raw)
        const index = typeof tc.index === 'number' ? tc.index : 0
        const fn = asRecord(tc.function)
        const existing = toolCalls.get(index) ?? { id: '', name: '', args: '' }
        if (typeof tc.id === 'string' && tc.id) existing.id = tc.id
        if (typeof fn.name === 'string' && fn.name) existing.name = fn.name
        if (typeof fn.arguments === 'string') existing.args += fn.arguments
        toolCalls.set(index, existing)
      }
    }

    const toolUses = [...toolCalls.values()].map(tc => ({
      id: tc.id || `${dayjs().valueOf()}-tool`,
      name: tc.name || 'unknown_tool',
      input: this.parseToolArgs(tc.args),
    }))

    return {
      text,
      stopReason: sawToolCalls && toolUses.length > 0 ? 'tool_use' : 'end_turn',
      toolUses,
      usage: { inputTokens, outputTokens },
    }
  }

  private parseToolArgs(args: string): Record<string, unknown> {
    if (!args.trim()) return {}
    try {
      return asRecord(JSON.parse(args))
    } catch {
      return {}
    }
  }

  async *callStream(params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    const body = {
      model: this.model,
      messages: params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      tools: this.buildTools(params),
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

    for await (const event of iterateSseData(response, 'openai')) {
      const choices = Array.isArray(event.choices) ? event.choices : []
      const delta = asRecord(asRecord(choices[0]).delta)
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text_delta', content: delta.content }
      }
      const reasoning =
        typeof delta.reasoning === 'string'
          ? delta.reasoning
          : typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : ''
      if (reasoning) yield { type: 'reasoning_delta', content: reasoning }
    }
  }
}

// ─── Google Gemini ──────────────────────────────────────────────

/** Gemini 2.5+ REST API accepts thinkingConfig.thinkingBudget (0 disables thinking). */
function geminiModelSupportsThinkingBudget(model: string): boolean {
  return /gemini-2\.5|gemini-3|gemini-exp/i.test(model)
}

function readNonNegInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  return undefined
}

/**
 * Parse Gemini `usageMetadata` into KB's `{ inputTokens, outputTokens }`.
 *
 * Google bills thinking at the output rate and reports it separately as
 * `thoughtsTokenCount` (candidates = visible answer only). Fold thoughts into
 * `outputTokens` so telemetry / eval `out=` match billed output:
 * `candidatesTokenCount + thoughtsTokenCount`.
 *
 * When `thoughtsTokenCount` is absent, fall back to
 * `max(candidates, totalTokenCount - promptTokenCount)` so streams that only
 * expose `totalTokenCount` still include thinking.
 */
export function parseGeminiUsageMetadata(usageMetadata: unknown): {
  inputTokens: number
  outputTokens: number
} {
  const usage = asRecord(usageMetadata)
  const inputTokens = readNonNegInt(usage.promptTokenCount) ?? 0
  const candidates = readNonNegInt(usage.candidatesTokenCount) ?? 0
  const thoughts =
    readNonNegInt(usage.thoughtsTokenCount) ??
    readNonNegInt(usage.thoughts_token_count) ??
    readNonNegInt(usage.thinkingTokenCount)

  let outputTokens = candidates + (thoughts ?? 0)
  if (thoughts === undefined) {
    const total = readNonNegInt(usage.totalTokenCount)
    if (total !== undefined) {
      const inferred = Math.max(0, total - inputTokens)
      if (inferred > outputTokens) outputTokens = inferred
    }
  }
  return { inputTokens, outputTokens }
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
    model = 'gemini-3-flash-preview'
  ) {
    this.model = model
  }

  /** Override via GEMINI_API_BASE_URL (e.g. WireMock in docker-compose integration runs). */
  private apiBase(): string {
    const override = process.env.GEMINI_API_BASE_URL?.trim()
    return override ? override.replace(/\/$/, '') : 'https://generativelanguage.googleapis.com'
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    if (params.onReasoning && !params.structuredJson?.gemini) {
      try {
        const reasoned = await this.callWithReasoning(params, params.onReasoning)
        // Accept only if it actually produced output. An empty result means the
        // thinking budget consumed the whole response (thinking models can spend
        // the entire output cap reasoning); fall through to the budget-escalating
        // path below rather than returning nothing.
        if (reasoned.text.trim() || (reasoned.toolUses?.length ?? 0) > 0) return reasoned
      } catch {
        // Fall back transparently if streaming fails.
      }
    }

    const initialBudget = params.maxTokens ?? 4096
    let budget = initialBudget
    let parsed = await this.generateContent(params, budget)
    const outputCap = 65_536
    for (
      let attempt = 0;
      attempt < 3 && parsed.finishReason === 'MAX_TOKENS' && budget < outputCap;
      attempt++
    ) {
      budget = Math.min(budget * 2, outputCap)
      parsed = await this.generateContent(params, budget)
    }

    // Guarantee a visible answer. If reasoning still exhausted the entire budget
    // (empty text, no tool call, truncated by MAX_TOKENS), retry once with
    // thinking disabled — that reliably yields a direct answer within budget.
    if (
      !parsed.text.trim() &&
      !(parsed.toolUses?.length ?? 0) &&
      parsed.finishReason === 'MAX_TOKENS' &&
      geminiModelSupportsThinkingBudget(this.model) &&
      params.thinkingBudget !== 0
    ) {
      parsed = await this.generateContent(
        { ...params, thinkingBudget: 0 },
        Math.max(budget, initialBudget)
      )
    }

    return {
      text: parsed.text,
      stopReason: parsed.stopReason,
      toolUses: parsed.toolUses,
      usage: parsed.usage,
    }
  }

  /** Build the unified message list into Gemini `contents`. */
  private buildContents(params: LLMCallParams): Array<Record<string, unknown>> {
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
          parts.push({
            functionCall: { name: tu.name, args: tu.input },
            // gemini-3.x rejects a tool round-trip (400) unless the model's own
            // thoughtSignature is echoed back on the functionCall it emitted.
            ...(tu.thoughtSignature ? { thoughtSignature: tu.thoughtSignature } : {}),
          })
        }
        geminiContents.push({ role: 'model', parts })
      } else {
        geminiContents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        })
      }
    }
    return geminiContents
  }

  private buildBody(
    params: LLMCallParams,
    maxOutputTokens: number,
    opts: { includeThoughts?: boolean } = {}
  ): Record<string, unknown> {
    const supportsThinking = geminiModelSupportsThinkingBudget(this.model)
    const thinkingConfig: Record<string, unknown> = {}
    if (supportsThinking) {
      // Always set an explicit budget — omitting thinkingConfig lets gemini-3.x
      // think dynamically with no cap. Resolution: per-call → GEMINI_THINKING_BUDGET
      // → mode default (on when includeThoughts, else off).
      let thinkingBudget = resolveGeminiThinkingBudget(params.thinkingBudget, {
        includeThoughts: Boolean(opts.includeThoughts),
      })
      if (opts.includeThoughts && thinkingBudget > 0) {
        // Leave room for the visible answer; never let thinking consume the
        // entire maxOutputTokens budget.
        thinkingBudget = Math.min(
          thinkingBudget,
          Math.max(256, Math.floor(maxOutputTokens / 4))
        )
        thinkingConfig.includeThoughts = true
      }
      thinkingConfig.thinkingBudget = thinkingBudget
    }

    return {
      contents: this.buildContents(params),
      ...(params.systemPrompt
        ? { system_instruction: { parts: [{ text: params.systemPrompt }] } }
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
        ...(Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}),
        ...(params.structuredJson?.gemini
          ? {
              responseMimeType: 'application/json',
              responseSchema: params.structuredJson.gemini,
            }
          : {}),
      },
    }
  }

  private async generateContent(
    params: LLMCallParams,
    maxOutputTokens: number
  ): Promise<{
    text: string
    stopReason: 'tool_use' | 'end_turn'
    toolUses: Array<{
      id: string
      name: string
      input: Record<string, unknown>
      thoughtSignature?: string
    }>
    usage: { inputTokens: number; outputTokens: number }
    finishReason?: string
  }> {
    const body = this.buildBody(params, maxOutputTokens)

    const response = await fetch(
      `${this.apiBase()}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    const data = await response.json()
    if (!response.ok) {
      throw providerApiError('gemini', response, data)
    }

    const payload = asRecord(data)
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    const first = asRecord(candidates[0])
    const contentRecord = asRecord(first.content)
    const content = Array.isArray(contentRecord.parts) ? contentRecord.parts : []

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
            // gemini-3.x attaches a thoughtSignature to each functionCall; capture
            // it so buildContents can echo it back on the tool round-trip turn.
            ...(typeof p.thoughtSignature === 'string'
              ? { thoughtSignature: p.thoughtSignature }
              : {}),
          }
        }),
      // thoughtsTokenCount is billed as output — see parseGeminiUsageMetadata.
      usage: parseGeminiUsageMetadata(payload.usageMetadata),
      finishReason: typeof first.finishReason === 'string' ? first.finishReason : undefined,
    }
  }

  /**
   * Streaming call with `includeThoughts` enabled. Thought parts are forwarded to
   * `onReasoning`; visible text and function calls reconstruct the {@link LLMResponse}.
   */
  private async callWithReasoning(
    params: LLMCallParams,
    onReasoning: (delta: string) => void
  ): Promise<LLMResponse> {
    const body = this.buildBody(params, params.maxTokens ?? 4096, { includeThoughts: true })

    const response = await fetch(
      `${this.apiBase()}/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    const toolUses: Array<{
      id: string
      name: string
      input: Record<string, unknown>
      thoughtSignature?: string
    }> = []

    for await (const event of iterateSseData(response, 'gemini')) {
      const candidates = Array.isArray(event.candidates) ? event.candidates : []
      const content = asRecord(asRecord(candidates[0]).content)
      const parts = Array.isArray(content.parts) ? content.parts : []
      for (const rawPart of parts) {
        const part = asRecord(rawPart)
        if (part.functionCall) {
          const call = asRecord(part.functionCall)
          toolUses.push({
            id: `${dayjs().valueOf()}-${Math.random()}`,
            name: typeof call.name === 'string' ? call.name : 'unknown_tool',
            input: asRecord(call.args),
            ...(typeof part.thoughtSignature === 'string'
              ? { thoughtSignature: part.thoughtSignature }
              : {}),
          })
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          if (part.thought === true) onReasoning(part.text)
          else text += part.text
        }
      }
      if (event.usageMetadata) {
        const parsed = parseGeminiUsageMetadata(event.usageMetadata)
        inputTokens = parsed.inputTokens
        outputTokens = parsed.outputTokens
      }
    }

    return {
      text,
      stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
      toolUses,
      usage: { inputTokens, outputTokens },
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
  readonly model: string

  constructor(
    private endpoint = 'http://localhost:11434',
    model = 'mistral'
  ) {
    this.model = model
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    if (params.onReasoning) {
      try {
        return await this.callWithReasoning(params, params.onReasoning)
      } catch {
        // Fall back transparently if streaming fails.
      }
    }

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
      throw providerApiError('ollama', response, data)
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

  /**
   * Streaming call with `think: true`. Forwards `message.thinking` deltas to `onReasoning`
   * and reconstructs the response text + token usage from the JSONL stream.
   */
  private async callWithReasoning(
    params: LLMCallParams,
    onReasoning: (delta: string) => void
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: params.messages,
        ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
        think: true,
        stream: true,
      }),
    })

    let text = ''
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of iterateJsonLines(response, 'ollama')) {
      const message = asRecord(event.message)
      if (typeof message.content === 'string') text += message.content
      if (typeof message.thinking === 'string' && message.thinking) onReasoning(message.thinking)
      if (typeof event.prompt_eval_count === 'number') inputTokens = event.prompt_eval_count
      if (typeof event.eval_count === 'number') outputTokens = event.eval_count
    }

    return {
      text,
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens, outputTokens },
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
