/**
 * Bridge the KB service to MCP.
 *
 * `kb_query` is an **agent-to-agent** channel: a coding agent asks the knowledge
 * base a direct question in plain terms and gets a direct, synthesized answer
 * plus the source files that answer is drawn from — not a raw fact dump to grep
 * through. We deliberately expose a **single** tool and always synthesize; the
 * evidence carries physical `filePath`s so the caller knows exactly what to open.
 * (A fact-id drill-down tool may return later.)
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { serializeQueryResult } from '@kb/core/service/serialize.js'
import type { KbService } from '@kb/core/service/kb-service.js'

const KB_QUERY_TOOL = {
  name: 'kb_query',
  description:
    'Ask the knowledge base a direct question in plain language, agent-to-agent. ' +
    'Returns a synthesized answer plus the source files it is drawn from (each ' +
    'result carries an openable filePath) — ask for exactly what you want instead ' +
    'of retrieving raw facts to sift through.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Natural-language question' },
    },
    required: ['q'],
    additionalProperties: false,
  },
} as const

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function textResult(payload: unknown): McpToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string): McpToolCallResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** Build the MCP tool list — the single agent-to-agent `kb_query` tool. */
export function buildMcpToolList(_service: KbService): McpToolDescriptor[] {
  return [{ ...KB_QUERY_TOOL, inputSchema: { ...KB_QUERY_TOOL.inputSchema } }]
}

/** Execute one MCP tool call against the service. Errors are returned as `isError` results. */
export async function dispatchMcpToolCall(
  service: KbService,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolCallResult> {
  try {
    if (name !== KB_QUERY_TOOL.name) {
      return errorResult(`Unknown or unavailable tool: ${name}`)
    }
    const q = typeof args.q === 'string' ? args.q : ''
    if (!q.trim()) return errorResult('kb_query requires a non-empty "q"')
    // Always answer-first: synthesize a direct answer, with source files as evidence.
    const result = await service.query({ query: q, synthesize: true })
    return textResult(serializeQueryResult(result))
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register `tools/list` and `tools/call` handlers backed by a `KbService`.
 * The one tool (`kb_query`) is `kb_`-prefixed to avoid collisions in multi-server clients.
 */
export function registerKbMcpHandlers(server: Server, service: KbService): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildMcpToolList(service),
  }))

  server.setRequestHandler(
    CallToolRequestSchema,
    async request =>
      dispatchMcpToolCall(
        service,
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>
      ) as Promise<CallToolResult>
  )
}
