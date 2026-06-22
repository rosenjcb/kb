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
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { handleMcpHttpRequest } from './mcp-server.js'
import { serializeQueryResult } from './serialize.js'
import type { KbService } from './kb-service.js'

export interface HttpServerOptions {
  service: KbService
  /** Accepted bearer keys. Empty array disables auth (with a startup warning). */
  apiKeys: string[]
  /** Mount the MCP Streamable HTTP endpoint at POST /mcp. */
  enableMcp?: boolean
  /** Per-request timeout for /v1/query (ms). Default 60s. */
  requestTimeoutMs?: number
  onLog?: (line: string) => void
}

const MAX_BODY_BYTES = 1 << 20 // 1 MiB

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

function isAuthorized(req: IncomingMessage, apiKeys: string[]): boolean {
  if (apiKeys.length === 0) return true
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const apiKey = bearer || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '')
  return apiKey !== '' && apiKeys.includes(apiKey)
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
  const { service, apiKeys, enableMcp = false, requestTimeoutMs = 60_000, onLog } = options

  return createServer((req, res) => {
    void handleRequest(req, res).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] unhandled error: ${message}`)
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = (req.url ?? '/').split('?')[0]

    // Unauthenticated health check (Cloud Run probes).
    if (method === 'GET' && (url === '/healthz' || url === '/health')) {
      const health = service.health()
      sendJson(res, health.ok ? 200 : 503, health)
      return
    }

    const protectedRoute =
      url === '/v1/query' || url === '/v1/chat' || url === '/v1/reindex' || url === '/mcp'
    if (protectedRoute && !isAuthorized(req, apiKeys)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (method === 'POST' && url === '/v1/query') {
      await handleQuery(req, res)
      return
    }

    if (method === 'POST' && url === '/v1/chat') {
      await handleChat(req, res)
      return
    }

    if (method === 'POST' && url === '/v1/reindex') {
      await handleReindex(res)
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
      await handleMcpHttpRequest(service, req, res, body)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  async function handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      sendJson(res, 200, serializeQueryResult(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message === 'query timed out' ? 504 : 500
      onLog?.(`[http] /v1/query error: ${message}`)
      sendJson(res, status, { error: message })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    send('session', { sessionId })

    try {
      for await (const event of service.chat({ sessionId, message })) {
        send(event.type, event)
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] /v1/chat error: ${errMessage}`)
      send('error', { type: 'error', message: errMessage })
    } finally {
      res.end()
    }
  }

  async function handleReindex(res: ServerResponse): Promise<void> {
    if (service.isReindexing()) {
      sendJson(res, 409, { error: 'reindex already in progress' })
      return
    }
    try {
      const summary = await service.reindex(line => onLog?.(`[reindex] ${line}`))
      sendJson(res, 200, { status: 'ok', summary })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onLog?.(`[http] /v1/reindex error: ${message}`)
      sendJson(res, 500, { error: message })
    }
  }
}
