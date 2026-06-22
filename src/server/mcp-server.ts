/**
 * MCP Streamable HTTP surface over the shared `KbService`.
 *
 * Mounted at `POST /mcp` when `kb server start --with-mcp` (or Docker CMD).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { KB_VERSION } from '../version.js'
import { registerKbMcpHandlers } from './mcp-tools.js'
import type { KbService } from './kb-service.js'

/** Construct an MCP `Server` with KB tool handlers registered. */
export function createKbMcpServer(service: KbService): Server {
  const server = new Server(
    { name: 'kb', version: KB_VERSION },
    { capabilities: { tools: {} } }
  )
  registerKbMcpHandlers(server, service)
  return server
}

/**
 * Handle a single MCP request over Streamable HTTP in stateless mode (a fresh
 * server + transport per request; no session affinity required — ideal for
 * Cloud Run autoscaling).
 */
export async function handleMcpHttpRequest(
  service: KbService,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
): Promise<void> {
  const server = createKbMcpServer(service)
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
