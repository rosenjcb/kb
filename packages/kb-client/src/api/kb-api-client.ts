import { KbConnectionError, formatApiError, throwConnectionError } from './connection-error.js'
import { resolveQueryTimeoutMs } from '@kb/core/config/query-timeout.js'
import type { ServerConnection } from './types.js'
import type {
  ApiErrorBody,
  ChatRequest,
  ChatStreamEvent,
  HealthResponse,
  QueryRequest,
  QueryResponse,
  QuerySource,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 60_000

function resolveClientTimeoutMs(override?: number): number {
  if (override !== undefined) return override
  try {
    return resolveQueryTimeoutMs()
  } catch {
    return DEFAULT_TIMEOUT_MS
  }
}

export interface KbApiClientOptions {
  connection: ServerConnection
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class KbApiClient {
  private readonly connection: ServerConnection
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: KbApiClientOptions) {
    this.connection = options.connection
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = resolveClientTimeoutMs(options.timeoutMs)
  }

  get connectionInfo(): ServerConnection {
    return this.connection
  }

  async health(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>('/healthz', { auth: false })
  }

  async connect(): Promise<HealthResponse> {
    try {
      return await this.health()
    } catch (error) {
      // `request()` already wraps network failures into a KbConnectionError; don't wrap
      // again (that duplicates the whole hint under a "Detail:" line).
      if (error instanceof KbConnectionError) throw error
      throwConnectionError(this.connection, error)
    }
  }

  async query(body: QueryRequest): Promise<QueryResponse> {
    return this.postJson<QueryResponse>('/v1/query', body)
  }

  async reindex(): Promise<{ status: string; summary: string }> {
    return this.postJson('/v1/reindex', {})
  }

  async adminCli(args: string[]): Promise<{ exitCode: number; output: string }> {
    return this.postJson('/v1/admin/cli', { args }, { timeoutMs: 30 * 60_000 })
  }

  async *chatStream(body: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const response = await this.request('/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(formatApiError(response.status, text))
    }
    if (!response.body) throw new Error('empty chat stream')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = parseSsePart(part)
        if (event) yield event
      }
    }
    if (buffer.trim()) {
      const event = parseSsePart(buffer)
      if (event) yield event
    }
  }

  private async getJson<T>(path: string, opts: { auth: boolean }): Promise<T> {
    const response = await this.request(path, { method: 'GET', auth: opts.auth })
    return readJsonResponse<T>(response)
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: opts?.timeoutMs,
    })
    return readJsonResponse<T>(response)
  }

  private async request(
    path: string,
    init: RequestInit & { auth?: boolean; timeoutMs?: number },
  ): Promise<Response> {
    const auth = init.auth !== false
    const headers = new Headers(init.headers)
    if (auth && this.connection.apiKey) {
      headers.set('Authorization', `Bearer ${this.connection.apiKey}`)
    }
    // Select the server-side base per request; omitted ⇒ server default base.
    if (this.connection.base) {
      headers.set('X-KB-Base', this.connection.base)
    }

    const timeoutMs = init.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.fetchImpl(`${this.connection.url}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`request timed out after ${timeoutMs}ms`)
      }
      throwConnectionError(this.connection, error)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(formatApiError(response.status, text))
  }
  if (!text) return {} as T
  return JSON.parse(text) as T
}

function parseSsePart(part: string): ChatStreamEvent | undefined {
  let eventName = ''
  let dataJson = ''
  for (const line of part.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) eventName = trimmed.slice('event:'.length).trim()
    if (trimmed.startsWith('data:')) dataJson = trimmed.slice('data:'.length).trim()
  }
  if (!dataJson) return undefined
  try {
    const payload = JSON.parse(dataJson) as Record<string, unknown>
    const type = (eventName || payload.type || '') as string
    if (type === 'session' && typeof payload.sessionId === 'string') {
      return { type: 'session', sessionId: payload.sessionId }
    }
    if (type === 'answer' && typeof payload.text === 'string') {
      return {
        type: 'answer',
        text: payload.text,
        sources: Array.isArray(payload.sources) ? (payload.sources as QuerySource[]) : [],
        factsRetrieved: typeof payload.factsRetrieved === 'number' ? payload.factsRetrieved : 0,
      }
    }
    if (type === 'reasoning' && typeof payload.text === 'string') {
      return { type: 'reasoning', text: payload.text }
    }
    if (type === 'meta' && typeof payload.text === 'string') {
      return { type: 'meta', text: payload.text }
    }
    if (type === 'error' && typeof payload.message === 'string') {
      return { type: 'error', message: payload.message }
    }
    if (type === 'done') {
      return { type: 'done' }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function createKbApiClient(connection: ServerConnection): KbApiClient {
  return new KbApiClient({ connection })
}

export type { ApiErrorBody }
