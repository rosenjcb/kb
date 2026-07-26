/**
 * MCP Streamable HTTP surface over the shared `KbService`.
 *
 * Mounted at `/mcp` when `kb-server start --with-mcp` (or Docker CMD).
 *
 * Sessions are stateful: initialize creates a server+transport pair keyed by
 * `mcp-session-id`, GET opens the SSE stream (needed for server→client
 * elicitation), and DELETE tears the session down.
 *
 * Default POST responses stay JSON (`enableJsonResponse: true`) so existing
 * clients/httpyac keep working. Set `KB_MCP_ELICITATION=true` to switch the
 * session to SSE POST streams so sampled feedback can `elicitInput` mid-call
 * (requires a client that declared the `elicitation` capability).
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isEnvTrue } from '@kb/core/config/env-boolean.js'
import type { KbService } from '@kb/core/service/kb-service.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { type McpDispatchOptions, registerKbMcpHandlers } from './mcp-tools.js'
import { resolveServerVersion } from './version.js'

interface McpSession {
  server: Server
  transport: StreamableHTTPServerTransport
  /** Mutable per-request opts closed over by tool handlers. */
  opts: McpDispatchOptions
}

/** Process-local MCP sessions (elicitation needs a durable server+SSE pair). */
const sessions = new Map<string, McpSession>()

/** Construct an MCP `Server` with KB tool handlers registered. */
export function createKbMcpServer(service: KbService, opts: McpDispatchOptions = {}): Server {
  const server = new Server(
    { name: 'kb', version: resolveServerVersion() },
    { capabilities: { tools: {} } }
  )
  registerKbMcpHandlers(server, service, opts)
  return server
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readElicitationEnabled(): boolean {
  return isEnvTrue(process.env.KB_MCP_ELICITATION)
}

async function createSession(service: KbService, opts: McpDispatchOptions): Promise<McpSession> {
  // Shared mutable opts so each HTTP request can refresh requestId.
  const elicitationEnabled = opts.elicitationEnabled ?? readElicitationEnabled()
  const sessionOpts: McpDispatchOptions = { ...opts, elicitationEnabled }
  // Holder so onsessioninitialized can close over the session before the
  // const binding is initialized (callback runs later, during initialize).
  const holder: { session?: McpSession } = {}
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // JSON POST responses by default; SSE when elicitation is opted in so
    // elicitation/create can ride the in-flight tool-call stream.
    enableJsonResponse: !elicitationEnabled,
    onsessioninitialized: sessionId => {
      if (holder.session) sessions.set(sessionId, holder.session)
    },
  })
  const server = createKbMcpServer(service, sessionOpts)
  const session: McpSession = { server, transport, opts: sessionOpts }
  holder.session = session
  transport.onclose = () => {
    const sid = transport.sessionId
    if (sid) sessions.delete(sid)
    void server.close()
  }
  await server.connect(transport)
  return session
}

/**
 * Handle one MCP HTTP request (POST/GET/DELETE) with session affinity.
 * `opts.requestId` is refreshed on every call for feedback correlation.
 */
export async function handleMcpHttpRequest(
  service: KbService,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  opts: McpDispatchOptions = {}
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const sessionId = headerValue(req, 'mcp-session-id')

  if (method === 'GET' || method === 'DELETE') {
    const session = sessionId ? sessions.get(sessionId) : undefined
    if (!session) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid or missing MCP session ID')
      return
    }
    session.opts.requestId = opts.requestId
    await session.transport.handleRequest(req, res, parsedBody)
    return
  }

  if (method !== 'POST') {
    sendJsonRpcError(res, 405, 'Method Not Allowed')
    return
  }

  const existing = sessionId ? sessions.get(sessionId) : undefined
  if (existing) {
    existing.opts.requestId = opts.requestId
    await existing.transport.handleRequest(req, res, parsedBody)
    return
  }

  if (!sessionId && isInitializeRequest(parsedBody)) {
    const session = await createSession(service, opts)
    session.opts.requestId = opts.requestId
    await session.transport.handleRequest(req, res, parsedBody)
    return
  }

  sendJsonRpcError(res, 400, 'Bad Request: No valid MCP session ID provided (initialize first)')
}

/** Test helper — drop all in-memory MCP sessions. */
export function resetMcpSessionsForTests(): void {
  for (const session of sessions.values()) {
    void session.transport.close()
    void session.server.close()
  }
  sessions.clear()
}
