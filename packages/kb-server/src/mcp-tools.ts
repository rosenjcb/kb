/**
 * Bridge the KB tool registry to MCP.
 *
 * MCP clients are themselves LLMs, so we expose retrieval tools (structured
 * facts) rather than a pre-synthesized prose answer. Each registry tool's JSON
 * Schema maps directly onto the MCP `inputSchema`. Only a read-only allowlist is
 * exposed — never `upsert_fact` on a hosted server.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { serializeQueryResult } from '@kb/core/service/serialize.js'
import type { KbService } from '@kb/core/service/kb-service.js'

/** Registry tool names exposed over MCP (read-only). */
const MCP_TOOL_ALLOWLIST = new Set([
  'read_facts',
  'search_code_symbols',
  'get_code_neighbors',
  'get_code_graph_summary',
])

const KB_QUERY_TOOL = {
  name: 'kb_query',
  description:
    'Ask a natural-language question of the knowledge base. Returns retrieved facts and sources (and, when synthesize=true, an LLM-synthesized answer).',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Natural-language question' },
      synthesize: {
        type: 'boolean',
        description: 'Include an LLM-synthesized answer (default false; MCP clients usually reason themselves)',
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

/** Build the MCP tool list (kb_query + allowlisted registry tools, `kb_`-prefixed). */
export function buildMcpToolList(service: KbService): McpToolDescriptor[] {
  const registryTools = service.toolExecutor
    .getTools()
    .filter(tool => MCP_TOOL_ALLOWLIST.has(tool.name))

  return [
    { ...KB_QUERY_TOOL, inputSchema: { ...KB_QUERY_TOOL.inputSchema } },
    ...registryTools.map(tool => ({
      name: `kb_${tool.name}`,
      description: tool.description,
      inputSchema: tool.schema as Record<string, unknown>,
    })),
  ]
}

/** Execute one MCP tool call against the service. Errors are returned as `isError` results. */
export async function dispatchMcpToolCall(
  service: KbService,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolCallResult> {
  try {
    if (name === KB_QUERY_TOOL.name) {
      const q = typeof args.q === 'string' ? args.q : ''
      if (!q.trim()) return errorResult('kb_query requires a non-empty "q"')
      const result = await service.query({
        query: q,
        synthesize: args.synthesize === true,
      })
      return textResult(serializeQueryResult(result))
    }

    const registryName = name.startsWith('kb_') ? name.slice(3) : name
    if (!MCP_TOOL_ALLOWLIST.has(registryName)) {
      return errorResult(`Unknown or unavailable tool: ${name}`)
    }
    const output = await service.toolExecutor.execute({ id: 'mcp', name: registryName, input: args })
    return textResult(output)
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register `tools/list` and `tools/call` handlers backed by a `KbService`.
 * Tool names are prefixed with `kb_` to avoid collisions in multi-server clients.
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
