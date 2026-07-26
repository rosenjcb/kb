/**
 * MCP Streamable HTTP surface over the shared `KbService`.
 *
 * Mounted at `POST /mcp` when `kb-server start --with-mcp` (or Docker CMD).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type McpDispatchOptions, registerKbMcpHandlers } from './mcp-tools.js'
import { resolveServerVersion } from './version.js'
import type { KbService } from '@kb/core/service/kb-service.js'

/** Construct an MCP `Server` with KB tool handlers registered. */
export function createKbMcpServer(service: KbService, opts: McpDispatchOptions = {}): Server {
  const server = new Server(
    { name: 'kb', version: resolveServerVersion() },
    { capabilities: { tools: {} } }
  )
  registerKbMcpHandlers(server, service, opts)
  return server
}

/**
 * Handle a single MCP request over Streamable HTTP in stateless mode (a fresh
 * server + transport per request; no session affinity required).
 */
export async function handleMcpHttpRequest(
  service: KbService,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  opts: McpDispatchOptions = {}
): Promise<void> {
  const server = createKbMcpServer(service, opts)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, parsedBody)
}
