/**
 * HTTP surface for `kb server start`.
 *
 * Built on `node:http` (zero extra deps, fast cold start) since the endpoint set
 * is small. Serves:
 *  - `GET  /healthz`     liveness/readiness (unauthenticated)
 *  - `POST /v1/query`    request/response synthesized answer (Slack & apps)
 *  - `POST /v1/chat`     multi-turn chat, streamed over SSE
 *  - `POST /v1/reindex`  on-demand incremental rescan
 *  - `POST /mcp`         MCP Streamable HTTP (when enabled)
 *
 * `/v1/*` and `/mcp` require a bearer API key when one is configured.
 *
 * Every request gets a `requestId` (UUID v4) attached as the `x-request-id`
 * response header and included in every structured log line for that request,
 * making it trivial to correlate client-side errors with server traces.
 *
 * Tracing is route-level and uniform: every request emits a `request` line on
 * entry and a `response` line on finish (status + `durationMs`), and each route
 * adds its own semantic logs — query/chat/reindex/mcp emit start/complete/error,
 * health checks log at debug, unauthorized and unknown-route hits log at warn.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { handleMcpHttpRequest } from './mcp-server.js'
import { serializeQueryResult } from './serialize.js'
import { log } from './logger.js'
import type { KbService } from './kb-service.js'
import {
  type SlackEventPayload,
  type SlackOptions,
  dispatchSlackEvent,
  isDuplicateEvent,
  verifySlackSignature,
} from './slack-handler.js'

export interface HttpServerOptions {
  service: KbService
  /** Accepted bearer keys. Empty array disables auth (with a startup warning). */
  apiKeys: string[]
  /** Mount the MCP Streamable HTTP endpoint at POST /mcp. */
  enableMcp?: boolean
  /** Per-request timeout for /v1/query (ms). Default 60s. */
  requestTimeoutMs?: number
  /** When set, mount POST /slack/events and verify Slack HMAC signatures. */
  slack?: SlackOptions
  onLog?: (line: string) => void
}

const MAX_BODY_BYTES = 1 << 20 // 1 MiB
const QUERY_LOG_MAX = 300      // truncate logged query/message text at this many chars

/** Per-request tracing context threaded through all handler functions. */
interface RequestCtx {
  requestId: string
  startMs: number
  method: string
  path: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Read the request body and return both the raw string (for HMAC verification)
 * and the parsed JSON. Does NOT trim the raw string before HMAC computation.
 */
function readRawAndJsonBody(req: IncomingMessage): Promise<{ raw: string; parsed: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({ raw: '', parsed: {} })
        return
      }
      try {
        resolve({ raw, parsed: JSON.parse(raw) })
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function isAuthorized(req: IncomingMessage, apiKeys: string[]): boolean {
  if (apiKeys.length === 0) return true
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const apiKey = bearer || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '')
  return apiKey !== '' && apiKeys.includes(apiKey)
}

/** Resolve the best available client IP for logging (proxy-aware). */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    return first.trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** Truncate a string for safe inclusion in a log line. */
function truncate(s: string, max = QUERY_LOG_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

interface QueryRequestBody {
  q?: string
  query?: string
  limit?: number
  type?: string
  discovery?: 'shallow' | 'deep'
  synthesize?: boolean
  verbose?: boolean
}

export function createHttpServer(options: HttpServerOptions): Server {
  const { service, apiKeys, enableMcp = false, requestTimeoutMs = 60_000, slack, onLog } = options

  return createServer((req, res) => {
    void handleRequest(req, res).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] unhandled error: ${message}`)
      log.error('unhandled request error', { error: message })
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID()
    const startMs = Date.now()
    const method = req.method ?? 'GET'
    const url = (req.url ?? '/').split('?')[0]
    const ctx: RequestCtx = { requestId, startMs, method, path: url }

    // Propagate request ID to caller so they can correlate server logs with their own.
    res.setHeader('x-request-id', requestId)

    log.info('request', {
      requestId,
      method,
      path: url,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? undefined,
      contentLength: req.headers['content-length'] ? Number(req.headers['content-length']) : undefined,
    })

    // Log every response — status + latency — regardless of which handler ran.
    res.on('finish', () => {
      const durationMs = Date.now() - startMs
      const status = res.statusCode
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      log[level]('response', { requestId, method, path: url, status, durationMs })
    })

    // Unauthenticated health check (Cloud Run probes). Logged at debug so the
    // probe cadence doesn't flood info-level logs; the response line still records it.
    if (method === 'GET' && (url === '/healthz' || url === '/health')) {
      const health = service.health()
      log.debug('health check', { requestId, ok: health.ok, indexMtime: health.indexMtime })
      sendJson(res, health.ok ? 200 : 503, health)
      return
    }

    const protectedRoute =
      url === '/v1/query' || url === '/v1/chat' || url === '/v1/reindex' || url === '/mcp'
    if (protectedRoute && !isAuthorized(req, apiKeys)) {
      log.warn('unauthorized', {
        requestId,
        method,
        path: url,
        // Log whether a key was supplied (not its value) to aid debugging.
        keyPresent: !!(req.headers.authorization || req.headers['x-api-key']),
      })
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (method === 'POST' && url === '/v1/query') {
      await handleQuery(req, res, ctx)
      return
    }

    if (method === 'POST' && url === '/v1/chat') {
      await handleChat(req, res, ctx)
      return
    }

    if (method === 'POST' && url === '/v1/reindex') {
      await handleReindex(res, ctx)
      return
    }

    if (enableMcp && url === '/mcp') {
      let body: unknown
      try {
        body = method === 'POST' ? await readJsonBody(req) : undefined
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
        return
      }
      await handleMcpRequest(service, req, res, body, ctx)
      return
    }

    if (slack && method === 'POST' && url === '/slack/events') {
      await handleSlackEvents(req, res, ctx, slack)
      return
    }

    // Unknown route — log so probes/misconfigured clients hitting bad paths are visible.
    log.warn('not found', { requestId, method, path: url })
    sendJson(res, 404, { error: 'not found' })
  }

  async function handleQuery(req: IncomingMessage, res: ServerResponse, ctx: RequestCtx): Promise<void> {
    let body: QueryRequestBody
    try {
      body = (await readJsonBody(req)) as QueryRequestBody
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
      return
    }

    const query = (body.q ?? body.query ?? '').trim()
    if (!query) {
      sendJson(res, 400, { error: 'missing "q"' })
      return
    }

    log.info('query start', {
      requestId: ctx.requestId,
      q: truncate(query),
      limit: body.limit,
      type: body.type,
      discovery: body.discovery,
      synthesize: body.synthesize !== false,
      verbose: body.verbose,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('query timed out')), requestTimeoutMs)
    })

    try {
      const result = await Promise.race([
        service.query({
          query,
          limit: body.limit,
          type: body.type,
          discovery: body.discovery,
          verbose: body.verbose,
          synthesize: body.synthesize !== false,
        }),
        timeout,
      ])
      const serialized = serializeQueryResult(result)
      log.info('query complete', {
        requestId: ctx.requestId,
        resultsCount: serialized.results.length,
        hasAnswer: serialized.answer !== null,
        status: serialized.status,
        retrievalMethod: serialized.retrieval.method,
        durationMs: Date.now() - ctx.startMs,
      })
      sendJson(res, 200, serialized)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message === 'query timed out' ? 504 : 500
      onLog?.(`[http] /v1/query error: ${message}`)
      log.error('query error', {
        requestId: ctx.requestId,
        error: message,
        status,
        durationMs: Date.now() - ctx.startMs,
      })
      sendJson(res, status, { error: message })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: RequestCtx): Promise<void> {
    let body: { sessionId?: string; message?: string }
    try {
      body = (await readJsonBody(req)) as { sessionId?: string; message?: string }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
      return
    }

    const message = (body.message ?? '').trim()
    if (!message) {
      sendJson(res, 400, { error: 'missing "message"' })
      return
    }
    const sessionId = body.sessionId?.trim() || randomUUID()

    log.info('chat start', {
      requestId: ctx.requestId,
      sessionId,
      msgLen: message.length,
      msg: truncate(message),
    })

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    send('session', { sessionId })

    let answerLen = 0
    let factsRetrieved = 0

    try {
      for await (const event of service.chat({ sessionId, message })) {
        send(event.type, event)
        log.debug('chat event', { requestId: ctx.requestId, sessionId, event: event.type })
        if (event.type === 'answer') {
          answerLen = event.text.length
          factsRetrieved = event.factsRetrieved
        }
      }
      log.info('chat complete', {
        requestId: ctx.requestId,
        sessionId,
        answerLen,
        factsRetrieved,
        durationMs: Date.now() - ctx.startMs,
      })
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] /v1/chat error: ${errMessage}`)
      log.error('chat error', {
        requestId: ctx.requestId,
        sessionId,
        error: errMessage,
        durationMs: Date.now() - ctx.startMs,
      })
      send('error', { type: 'error', message: errMessage })
    } finally {
      res.end()
    }
  }

  async function handleReindex(res: ServerResponse, ctx: RequestCtx): Promise<void> {
    if (service.isReindexing()) {
      log.warn('reindex already in progress', { requestId: ctx.requestId })
      sendJson(res, 409, { error: 'reindex already in progress' })
      return
    }
    log.info('reindex start', { requestId: ctx.requestId })
    try {
      const summary = await service.reindex(line => {
        onLog?.(`[reindex] ${line}`)
        log.debug('reindex progress', { requestId: ctx.requestId, line })
      })
      log.info('reindex complete', {
        requestId: ctx.requestId,
        summary,
        durationMs: Date.now() - ctx.startMs,
      })
      sendJson(res, 200, { status: 'ok', summary })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] /v1/reindex error: ${message}`)
      log.error('reindex error', {
        requestId: ctx.requestId,
        error: message,
        durationMs: Date.now() - ctx.startMs,
      })
      sendJson(res, 500, { error: message })
    }
  }

  async function handleSlackEvents(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestCtx,
    slackOpts: SlackOptions,
  ): Promise<void> {
    let raw: string
    let parsed: unknown
    try {
      ;({ raw, parsed } = await readRawAndJsonBody(req))
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
      return
    }

    const timestamp =
      typeof req.headers['x-slack-request-timestamp'] === 'string'
        ? req.headers['x-slack-request-timestamp']
        : undefined
    const signature =
      typeof req.headers['x-slack-signature'] === 'string'
        ? req.headers['x-slack-signature']
        : undefined

    if (!verifySlackSignature(slackOpts.signingSecret, raw, timestamp, signature)) {
      log.warn('slack signature rejected', { requestId: ctx.requestId, keyPresent: !!signature })
      sendJson(res, 401, { error: 'invalid signature' })
      return
    }

    const payload = parsed as SlackEventPayload

    // URL verification challenge — Slack sends this when first registering the webhook.
    if (payload.type === 'url_verification') {
      log.info('slack url_verification', { requestId: ctx.requestId })
      sendJson(res, 200, { challenge: payload.challenge })
      return
    }

    // Deduplicate retried events before dispatching.
    const eventId = payload.event_id
    if (eventId && isDuplicateEvent(eventId)) {
      log.info('slack duplicate event ignored', { requestId: ctx.requestId, eventId })
      sendJson(res, 200, {})
      return
    }

    // Ack immediately — Slack requires a response within 3 seconds.
    sendJson(res, 200, {})

    log.info('slack event received', {
      requestId: ctx.requestId,
      eventId,
      eventType: payload.event?.type,
      channelType: payload.event?.channel_type,
      hasThreadTs: !!payload.event?.thread_ts,
    })

    void dispatchSlackEvent(service, slackOpts, payload).catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      onLog?.(`[slack] dispatch error: ${message}`)
      log.error('slack dispatch error', { requestId: ctx.requestId, error: message })
    })
  }
}

async function handleMcpRequest(
  service: KbService,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  ctx: RequestCtx
): Promise<void> {
  // Extract the JSON-RPC method name for logging (best-effort, body may be null/non-object).
  const rpcMethod =
    body && typeof body === 'object' && 'method' in body && typeof (body as Record<string, unknown>).method === 'string'
      ? (body as Record<string, unknown>).method as string
      : undefined

  log.info('mcp request', { requestId: ctx.requestId, rpcMethod })
  try {
    await handleMcpHttpRequest(service, req, res, body)
    log.info('mcp complete', {
      requestId: ctx.requestId,
      rpcMethod,
      durationMs: Date.now() - ctx.startMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('mcp error', {
      requestId: ctx.requestId,
      rpcMethod,
      error: message,
      durationMs: Date.now() - ctx.startMs,
    })
    throw error // let the top-level handler send the 500 / end the response
  }
}
