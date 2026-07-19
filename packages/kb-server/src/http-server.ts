/**
 * HTTP surface for `kb-server start`.
 *
 * Built on `node:http` (zero extra deps, fast cold start) since the endpoint set
 * is small. Serves:
 *  - `GET  /healthz`     liveness (unauthenticated; always 200 when reachable)
 *  - `POST /v1/query`    one-shot request/response synthesized answer (apps wanting a single call)
 *  - `POST /v1/chat`     multi-turn chat loop, streamed over SSE — also the path Slack uses (via `service.chat`)
 *  - `POST /mcp`         MCP Streamable HTTP (when enabled)
 *
 * Index refresh is **not** an HTTP route — use `KB_REINDEX_INTERVAL` (scheduler)
 * or `kb-server scan` offline. `/v1/*` and `/mcp` require a bearer API key when
 * one is configured.
 *
 * Every request gets a `requestId` (UUID v4) attached as the `x-request-id`
 * response header and included in every structured log line for that request,
 * making it trivial to correlate client-side errors with server traces.
 *
 * Tracing is route-level and uniform: every request emits a `request` line on
 * entry and a `response` line on finish (status + `durationMs`), and each route
 * adds its own semantic logs — query/chat/mcp emit start/complete/error,
 * health checks log at debug, unauthorized and unknown-route hits log at warn.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolveQueryTimeoutMs } from '@kb/core/config/query-timeout.js'
import { handleMcpHttpRequest } from './mcp-server.js'
import { handleAdminRoute } from './admin-routes.js'
import { serializeQueryResult } from '@kb/core/service/serialize.js'
import { log } from './logger.js'
import { resolveServerVersion } from './version.js'
import { BOOTSTRAP_INDEXING_MESSAGE, type KbService } from '@kb/core/service/kb-service.js'
import { BaseNotFoundError, type KbServiceRegistry } from './service-registry.js'
import {
  type SlackEventPayload,
  type SlackOptions,
  dispatchSlackEvent,
  isDuplicateEvent,
  verifySlackSignature,
} from './slack-handler.js'
import { ReportWriter, RunCollector, estimateCost, type RunReport } from '@kb/core/core/telemetry.js'

export interface HttpServerOptions {
  /** The boot/default base service (serves requests with no `X-KB-Base`). */
  service: KbService
  /**
   * Multi-base registry. When present, `X-KB-Base` (or `?base=` / body `base`)
   * selects a service; an unknown base ⇒ 404. When absent the server is
   * single-base and every request uses `service`.
   */
  registry?: KbServiceRegistry
  /** Accepted bearer keys. Empty array disables auth (with a startup warning). */
  apiKeys: string[]
  /**
   * Browser origins allowed to call the API cross-origin (CORS). Empty/omitted
   * disables CORS entirely (same-origin/native clients only). A single `*`
   * entry allows any origin; otherwise the request `Origin` is echoed back only
   * when it matches an allow-list entry. Enables the hosted "try it" chat page
   * (e.g. GitHub Pages) to reach a kb-server.
   */
  allowedOrigins?: string[]
  /** Mount the MCP Streamable HTTP endpoint at POST /mcp. */
  enableMcp?: boolean
  /** Per-request timeout for /v1/query (ms). Default 60s. */
  requestTimeoutMs?: number
  /** When set, mount POST /slack/events and verify Slack HMAC signatures. */
  slack?: SlackOptions
  onLog?: (line: string) => void
  /** When set, write RunReport entries here so `kb logs` surfaces server traffic. */
  logsDir?: string
  /** Host:port label for persisted run reports (e.g. localhost:38117). */
  reportHost?: string
  /** Called after each RunReport is appended. Intended for testing. */
  onReportWritten?: (report: RunReport) => void
}

const MAX_BODY_BYTES = 1 << 20 // 1 MiB
const QUERY_LOG_MAX = 300      // truncate logged query/message text at this many chars

/** Request headers a browser may send to the API (echoed in preflight). */
const CORS_ALLOW_HEADERS = 'authorization, content-type, x-api-key, x-kb-base'
/** Methods the API exposes to browsers. */
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS'
/** Cache the preflight result for 24h to avoid an OPTIONS on every call. */
const CORS_MAX_AGE = '86400'

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

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request, or null when
 * CORS is disabled or the origin isn't allowed. `*` in the allow-list echoes
 * `*`; otherwise the request `Origin` is reflected only on an exact match.
 * Auth uses a bearer token (not cookies), so credentialed CORS isn't needed —
 * `*` is safe here.
 */
function resolveCorsOrigin(req: IncomingMessage, allowedOrigins: string[]): string | null {
  if (allowedOrigins.length === 0) return null
  if (allowedOrigins.includes('*')) return '*'
  const header = req.headers.origin
  const origin = Array.isArray(header) ? header[0] : header
  if (origin && allowedOrigins.includes(origin)) return origin
  return null
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
  discovery?: 'shallow' | 'deep'
  synthesize?: boolean
  verbose?: boolean
  trace?: boolean
  /** Per-call base override (else the connection's `X-KB-Base`). */
  base?: string
}

interface ServiceUnavailableResponse {
  error: string
  status: 'indexing' | 'bootstrap_failed'
  progress?: string
}

export function createHttpServer(options: HttpServerOptions): Server {
  const {
    service,
    registry,
    apiKeys,
    enableMcp = false,
    requestTimeoutMs = resolveQueryTimeoutMs(),
    slack,
    onLog,
    allowedOrigins = [],
  } = options

  const reportWriter = options.logsDir ? new ReportWriter(options.logsDir) : null
  const reportHost = options.reportHost

  /** The base slug requested via header or `?base=` query, if any. */
  function requestedBaseSlug(req: IncomingMessage): string | undefined {
    const header = req.headers['x-kb-base']
    const headerVal = Array.isArray(header) ? header[0] : header
    if (headerVal?.trim()) return headerVal.trim()
    const q = (req.url ?? '').split('?')[1]
    if (q) {
      const value = new URLSearchParams(q).get('base')
      if (value?.trim()) return value.trim()
    }
    return undefined
  }

  /**
   * Resolve the service for a request's base slug. Returns null (and sends 404)
   * when a registry is present and the base is unknown. Falls back to the boot
   * `service` when no slug is given or no registry is configured.
   */
  function resolveServiceOr404(slug: string | undefined, res: ServerResponse): KbService | null {
    if (!slug || !registry) return service
    try {
      return registry.resolve(slug)
    } catch (error) {
      if (error instanceof BaseNotFoundError) {
        sendJson(res, 404, { error: error.message, status: 'unknown_base' })
        return null
      }
      throw error
    }
  }

  function writeReport(report: RunReport): void {
    if (!reportWriter) return
    const withHost = reportHost && !report.host ? { ...report, host: reportHost } : report
    void reportWriter.append(withHost).then(() => options.onReportWritten?.(withHost))
  }

  function buildAndWriteReport(
    command: string,
    ctx: RequestCtx,
    status: 'success' | 'error',
    svc: KbService,
    opts: {
      sessionId?: string
      errorMessage?: string
      inputTokens?: number
      outputTokens?: number
      provider?: string
      model?: string
    } = {}
  ): void {
    if (!reportWriter) return
    const now = Date.now()
    const svcHealth = svc.health()
    const collector = new RunCollector(command, {
      sessionId: opts.sessionId,
      base: svcHealth.base,
      host: reportHost,
    })
    const inputTokens = opts.inputTokens ?? 0
    const outputTokens = opts.outputTokens ?? 0
    if (inputTokens > 0 || outputTokens > 0) {
      const provider = opts.provider ?? svcHealth.provider ?? 'unknown'
      const model = opts.model ?? svcHealth.model ?? 'unknown'
      collector.addStage({
        stage: command,
        startedAt: new Date(ctx.startMs).toISOString(),
        durationMs: now - ctx.startMs,
        inputTokens,
        outputTokens,
        estimatedCostUsd: estimateCost(provider, model, inputTokens, outputTokens),
        provider,
        model,
      })
    }
    const report = collector.finish(status, opts.errorMessage)
    report.runId = `run-${ctx.startMs}-${Math.random().toString(36).slice(2, 6)}`
    report.totalDurationMs = now - ctx.startMs
    report.startedAt = new Date(ctx.startMs).toISOString()
    report.finishedAt = new Date(now).toISOString()
    writeReport(report)
  }

  function finalizeHttpReport(
    collector: RunCollector,
    ctx: RequestCtx,
    status: 'success' | 'error',
    errorMessage?: string
  ): RunReport {
    const now = Date.now()
    const report = collector.finish(status, errorMessage)
    report.runId = `run-${ctx.startMs}-${Math.random().toString(36).slice(2, 6)}`
    report.totalDurationMs = now - ctx.startMs
    report.startedAt = new Date(ctx.startMs).toISOString()
    report.finishedAt = new Date(now).toISOString()
    return report
  }

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

    // CORS: set before any writeHead so the headers ride every response (JSON,
    // SSE, errors). Answer preflight OPTIONS here — it carries no auth and must
    // succeed before the browser will send the real request.
    const corsOrigin = resolveCorsOrigin(req, allowedOrigins)
    if (corsOrigin) {
      res.setHeader('access-control-allow-origin', corsOrigin)
      // Reflected (non-`*`) origins are cache-key-sensitive; vary so shared
      // caches don't serve one origin's headers to another.
      if (corsOrigin !== '*') res.setHeader('vary', 'Origin')
    }
    if (method === 'OPTIONS') {
      const headers: Record<string, string> = { 'content-length': '0' }
      if (corsOrigin) {
        headers['access-control-allow-methods'] = CORS_ALLOW_METHODS
        headers['access-control-allow-headers'] = CORS_ALLOW_HEADERS
        headers['access-control-max-age'] = CORS_MAX_AGE
      }
      res.writeHead(corsOrigin ? 204 : 405, headers)
      res.end()
      return
    }

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

    // Unauthenticated health check. Logged at debug so the
    // probe cadence doesn't flood info-level logs; the response line still records it.
    if (method === 'GET' && (url === '/healthz' || url === '/health')) {
      // `?base=` / `X-KB-Base` reports a specific served base's readiness so a
      // multi-base client can probe the exact base it will query.
      const healthSvc = resolveServiceOr404(requestedBaseSlug(req), res)
      if (!healthSvc) return
      const health = healthSvc.health()
      const body = {
        ...health,
        version: {
          server: resolveServerVersion(),
        },
      }
      log.debug('health check', {
        requestId,
        ok: body.ok,
        indexMtime: body.indexMtime,
        version: body.version,
      })
      // Always HTTP 200 when the process can answer (liveness). Readiness is in
      // the body: `ok`, `indexing`, `reindexing`, `bootstrapError`. Query/chat
      // still 503 during first-boot indexing via serviceUnavailableError.
      sendJson(res, 200, body)
      return
    }

    const protectedRoute =
      url === '/v1/query' ||
      url === '/v1/chat' ||
      url === '/mcp' ||
      url.startsWith('/v1/facts') ||
      url.startsWith('/v1/docs') ||
      url.startsWith('/v1/graph') ||
      url.startsWith('/v1/logs') ||
      url.startsWith('/v1/bases') ||
      url.startsWith('/v1/admin')
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

    // Select the base for this request (X-KB-Base / ?base=); 404 on unknown base.
    const svc = resolveServiceOr404(requestedBaseSlug(req), res)
    if (!svc) return

    if (method === 'POST' && url === '/v1/query') {
      const unavailable = serviceUnavailableError(svc)
      if (unavailable) {
        sendJson(res, 503, unavailable)
        return
      }
      await handleQuery(req, res, ctx, svc)
      return
    }

    if (method === 'POST' && url === '/v1/chat') {
      const unavailable = serviceUnavailableError(svc)
      if (unavailable) {
        sendJson(res, 503, unavailable)
        return
      }
      await handleChat(req, res, ctx, svc)
      return
    }

    if (
      await handleAdminRoute(method, url, req, res, {
        service: svc,
        baseDir: svc.baseDir,
        registry,
      })
    ) {
      return
    }

    if (enableMcp && url === '/mcp') {
      const unavailable = serviceUnavailableError(svc)
      if (unavailable) {
        sendJson(res, 503, unavailable)
        return
      }
      let body: unknown
      try {
        body = method === 'POST' ? await readJsonBody(req) : undefined
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
        return
      }
      try {
        await handleMcpRequest(svc, req, res, body, ctx)
        buildAndWriteReport('mcp', ctx, 'success', svc, { sessionId: ctx.requestId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        buildAndWriteReport('mcp', ctx, 'error', svc, {
          sessionId: ctx.requestId,
          errorMessage: message,
        })
        throw error
      }
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

  function serviceUnavailableError(svc: KbService): ServiceUnavailableResponse | null {
    const health = svc.health()
    if (health.indexing) {
      return {
        error: BOOTSTRAP_INDEXING_MESSAGE,
        status: 'indexing',
        ...(health.bootstrapProgress ? { progress: health.bootstrapProgress } : {}),
      }
    }
    if (health.bootstrapError) {
      return {
        error: `server bootstrap failed: ${health.bootstrapError}`,
        status: 'bootstrap_failed',
        ...(health.bootstrapProgress ? { progress: health.bootstrapProgress } : {}),
      }
    }
    return null
  }

  async function handleQuery(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestCtx,
    resolvedSvc: KbService
  ): Promise<void> {
    let body: QueryRequestBody
    try {
      body = (await readJsonBody(req)) as QueryRequestBody
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
      return
    }

    // A body `base` overrides the header selection for this call.
    let svc = resolvedSvc
    if (body.base?.trim()) {
      const overridden = resolveServiceOr404(body.base.trim(), res)
      if (!overridden) return
      svc = overridden
      const unavailable = serviceUnavailableError(svc)
      if (unavailable) {
        sendJson(res, 503, unavailable)
        return
      }
    }

    const query = (body.q ?? body.query ?? '').trim()
    if (!query) {
      sendJson(res, 400, { error: 'missing "q"' })
      return
    }

    log.info('query start', {
      requestId: ctx.requestId,
      q: truncate(query),
      discovery: body.discovery,
      synthesize: body.synthesize !== false,
      verbose: body.verbose,
      trace: body.trace === true,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('query timed out')), requestTimeoutMs)
    })

    const collector = new RunCollector('query', {
      sessionId: ctx.requestId,
      base: svc.health().base,
      host: reportHost,
    })

    try {
      const result = await Promise.race([
        svc.query({
          query,
          discovery: body.discovery,
          verbose: body.verbose,
          synthesize: body.synthesize !== false,
          trace: body.trace === true,
          collector,
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
      writeReport(finalizeHttpReport(collector, ctx, 'success'))
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
      writeReport(finalizeHttpReport(collector, ctx, 'error', message))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestCtx,
    resolvedSvc: KbService
  ): Promise<void> {
    let body: { sessionId?: string; message?: string; base?: string }
    try {
      body = (await readJsonBody(req)) as { sessionId?: string; message?: string; base?: string }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
      return
    }

    // A body `base` overrides the header selection for this call.
    let svc = resolvedSvc
    if (body.base?.trim()) {
      const overridden = resolveServiceOr404(body.base.trim(), res)
      if (!overridden) return
      svc = overridden
      const unavailable = serviceUnavailableError(svc)
      if (unavailable) {
        sendJson(res, 503, unavailable)
        return
      }
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
    let inputTokens = 0
    let outputTokens = 0

    const svcHealth = svc.health()
    try {
      for await (const event of svc.chat({ sessionId, message })) {
        send(event.type, event)
        log.debug('chat event', { requestId: ctx.requestId, sessionId, event: event.type })
        if (event.type === 'answer') {
          answerLen = event.text.length
          factsRetrieved = event.factsRetrieved
        }
        if (event.type === 'done') {
          inputTokens = event.inputTokens ?? 0
          outputTokens = event.outputTokens ?? 0
        }
      }
      log.info('chat complete', {
        requestId: ctx.requestId,
        sessionId,
        answerLen,
        factsRetrieved,
        durationMs: Date.now() - ctx.startMs,
      })
      buildAndWriteReport('chat', ctx, 'success', svc, {
        sessionId,
        inputTokens,
        outputTokens,
        provider: svcHealth.provider,
        model: svcHealth.model,
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
      buildAndWriteReport('chat', ctx, 'error', svc, {
        sessionId,
        errorMessage: errMessage,
        inputTokens,
        outputTokens,
        provider: svcHealth.provider,
        model: svcHealth.model,
      })
    } finally {
      res.end()
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
    // Slack always uses the boot/default base (no per-request base selection).
    sendJson(res, 200, {})
    buildAndWriteReport('slack', ctx, 'success', service, { sessionId: ctx.requestId })

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
