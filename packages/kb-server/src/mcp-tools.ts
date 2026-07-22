/**
 * Bridge the KB service to MCP.
 *
 * `kb_query` is an **agent-to-agent** channel: a coding agent asks the knowledge
 * base a direct question in plain terms and gets a direct, synthesized answer
 * plus compact source citations (`path (symbol)`) — not a raw fact dump to grep
 * through. We deliberately expose a **single** tool and always synthesize; the
 * citations are physical file paths so the caller knows exactly what to open.
 * The full evidence payload (per-fact snippets, tags, retrieval metadata) is
 * opt-in via `verbose: true`. (A fact-id drill-down tool may return later.)
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { serializeMcpQueryResult, serializeQueryResult } from '@kb/core/service/serialize.js'
import type { KbService } from '@kb/core/service/kb-service.js'

const KB_QUERY_TOOL = {
  name: 'kb_query',
  description:
    'Ask the knowledge base a direct question in plain language, agent-to-agent. ' +
    'Returns a synthesized answer plus compact source citations ("path (symbol)") ' +
    'to open and verify — ask for exactly what you want instead of retrieving raw ' +
    'facts to sift through. Set verbose:true only when you need the full evidence ' +
    'payload (per-fact snippets, tags, retrieval metadata).',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Natural-language question' },
      verbose: {
        type: 'boolean',
        description:
          'Return the full evidence payload (every fact with snippet/tags plus retrieval ' +
          'metadata) instead of the default trimmed answer + sources. Default false.',
      },
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
    const verbose = args.verbose === true
    // Always answer-first: synthesize a direct answer, with source files as evidence.
    const result = await service.query({ query: q, synthesize: true })
    // Default is the trimmed agent payload (answer + citations + notes); the full
    // fact dump and retrieval metadata are opt-in via verbose.
    return textResult(verbose ? serializeQueryResult(result) : serializeMcpQueryResult(result))
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
