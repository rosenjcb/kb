/**
 * Bridge the KB service to MCP.
 *
 * `kb_query` is an **agent-to-agent** channel: a coding agent asks the knowledge
 * base a direct question in plain terms and gets a direct, synthesized answer
 * plus compact source citations (`path (symbol)`) — not a raw fact dump to grep
 * through. The MCP surface is exactly two tools — `kb_query` and its feedback
 * channel `submit_feedback` — and kb_query always synthesizes; the citations
 * are physical file paths so the caller knows exactly what to open. The full
 * evidence payload (per-fact snippets, tags, retrieval metadata) is opt-in via
 * `verbose: true`. (A fact-id drill-down tool may return later.)
 *
 * `submit_feedback` closes the loop: agents report whether a kb_query answer
 * held up once they acted on it. A sampled nudge (KB_FEEDBACK_SAMPLE_RATE) is
 * appended to kb_query responses to prompt the call, and every kb_query payload
 * carries the server `requestId` so feedback joins the RunReport telemetry.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { serializeMcpQueryResult, serializeQueryResult } from '@kb/core/service/serialize.js'
import type { KbService } from '@kb/core/service/kb-service.js'
import {
  type FeedbackHelped,
  type FeedbackScores,
  type QueryFeedbackRecord,
  QueryFeedbackStore,
  defaultFeedbackDir,
} from './query-feedback-store.js'

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

const FEEDBACK_HELPED_VALUES: readonly FeedbackHelped[] = ['yes', 'partial', 'no']

const FEEDBACK_SCORE_AXES = [
  'correctness',
  'usefulness',
  'relevance',
  'specificity',
  'evidence_handling',
] as const

const SUBMIT_FEEDBACK_TOOL = {
  name: 'submit_feedback',
  description:
    'Report whether a kb_query answer held up once you acted on it. Call this after ' +
    'finishing the work the answer informed — especially when a kb_query response asked ' +
    'for feedback. One call can cover several queries: echo their requestIds and say what ' +
    'was right, missing, or wrong in notes.',
  inputSchema: {
    type: 'object',
    properties: {
      helped: {
        type: 'string',
        enum: ['yes', 'partial', 'no'],
        description: 'Did the kb_query answer(s) help you complete the task?',
      },
      notes: {
        type: 'string',
        description:
          'What was right, missing, or wrong — cite the files or facts involved when you can.',
      },
      query: {
        type: 'string',
        description: 'The kb_query question(s) this feedback is about.',
      },
      requestIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'requestId values echoed from the kb_query responses this feedback covers.',
      },
      scores: {
        type: 'object',
        properties: {
          correctness: { type: 'integer', minimum: 0, maximum: 4 },
          usefulness: { type: 'integer', minimum: 0, maximum: 4 },
          relevance: { type: 'integer', minimum: 0, maximum: 4 },
          specificity: { type: 'integer', minimum: 0, maximum: 4 },
          evidence_handling: { type: 'integer', minimum: 0, maximum: 4 },
        },
        additionalProperties: false,
        description: 'Optional 0-4 ratings on the evaluation axes; include only strong signals.',
      },
    },
    required: ['helped'],
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

/** Per-request wiring for tool dispatch; every field has a production default. */
export interface McpDispatchOptions {
  /** Server-assigned id of this HTTP request, echoed into payloads for feedback correlation. */
  requestId?: string
  /** Overrides the KB_FEEDBACK_SAMPLE_RATE env var (tests). */
  feedbackSampleRate?: number
  /** Injectable RNG for the nudge sampling gate (tests). */
  random?: () => number
  /** Overrides the default on-disk feedback store (tests). */
  feedbackStore?: QueryFeedbackStore
}

function textResult(payload: unknown): McpToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string): McpToolCallResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** Fraction of kb_query responses that carry the feedback nudge. Default 0 (off). */
function readFeedbackSampleRate(): number {
  const raw = process.env.KB_FEEDBACK_SAMPLE_RATE?.trim()
  if (!raw) return 0
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(1, Math.max(0, parsed))
}

let sharedFeedbackStore: QueryFeedbackStore | undefined

function resolveFeedbackStore(opts: McpDispatchOptions): QueryFeedbackStore {
  if (opts.feedbackStore) return opts.feedbackStore
  sharedFeedbackStore ??= new QueryFeedbackStore(defaultFeedbackDir())
  return sharedFeedbackStore
}

function feedbackNudge(requestId: string | undefined): string {
  const ids = requestId ? ` requestIds: ["${requestId}"],` : ''
  return `Feedback requested: after acting on this answer, call submit_feedback (helped: "yes"|"partial"|"no",${ids} notes) to report whether it held up.`
}

/** Validate submit_feedback args into a record body, or return an error string. */
function parseFeedbackArgs(
  args: Record<string, unknown>
): { helped: FeedbackHelped; notes?: string; query?: string; requestIds?: string[]; scores?: FeedbackScores } | string {
  const helped = args.helped
  if (typeof helped !== 'string' || !FEEDBACK_HELPED_VALUES.includes(helped as FeedbackHelped)) {
    return 'submit_feedback requires "helped": one of "yes", "partial", "no"'
  }
  if (args.notes !== undefined && typeof args.notes !== 'string') {
    return 'submit_feedback "notes" must be a string'
  }
  if (args.query !== undefined && typeof args.query !== 'string') {
    return 'submit_feedback "query" must be a string'
  }
  let requestIds: string[] | undefined
  if (args.requestIds !== undefined) {
    if (!Array.isArray(args.requestIds) || args.requestIds.some(id => typeof id !== 'string')) {
      return 'submit_feedback "requestIds" must be an array of strings'
    }
    requestIds = args.requestIds as string[]
  }
  let scores: FeedbackScores | undefined
  if (args.scores !== undefined) {
    if (typeof args.scores !== 'object' || args.scores === null || Array.isArray(args.scores)) {
      return 'submit_feedback "scores" must be an object of 0-4 integers'
    }
    scores = {}
    for (const [axis, value] of Object.entries(args.scores as Record<string, unknown>)) {
      if (!(FEEDBACK_SCORE_AXES as readonly string[]).includes(axis)) {
        return `submit_feedback "scores" axis "${axis}" is not one of: ${FEEDBACK_SCORE_AXES.join(', ')}`
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4) {
        return `submit_feedback "scores.${axis}" must be an integer from 0 to 4`
      }
      scores[axis as keyof FeedbackScores] = value
    }
  }
  return {
    helped: helped as FeedbackHelped,
    ...(typeof args.notes === 'string' && args.notes.trim() ? { notes: args.notes } : {}),
    ...(typeof args.query === 'string' && args.query.trim() ? { query: args.query } : {}),
    ...(requestIds && requestIds.length > 0 ? { requestIds } : {}),
    ...(scores && Object.keys(scores).length > 0 ? { scores } : {}),
  }
}

/** Build the MCP tool list — the agent-to-agent `kb_query` tool plus `submit_feedback`. */
export function buildMcpToolList(_service: KbService): McpToolDescriptor[] {
  return [
    { ...KB_QUERY_TOOL, inputSchema: { ...KB_QUERY_TOOL.inputSchema } },
    { ...SUBMIT_FEEDBACK_TOOL, inputSchema: { ...SUBMIT_FEEDBACK_TOOL.inputSchema } },
  ]
}

/** Execute one MCP tool call against the service. Errors are returned as `isError` results. */
export async function dispatchMcpToolCall(
  service: KbService,
  name: string,
  args: Record<string, unknown>,
  opts: McpDispatchOptions = {}
): Promise<McpToolCallResult> {
  try {
    if (name === SUBMIT_FEEDBACK_TOOL.name) {
      const parsed = parseFeedbackArgs(args)
      if (typeof parsed === 'string') return errorResult(parsed)
      const record: QueryFeedbackRecord = {
        ts: new Date().toISOString(),
        source: 'mcp',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...parsed,
      }
      await resolveFeedbackStore(opts).append(record)
      return textResult({ status: 'ok', message: 'Feedback recorded — thank you.' })
    }
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
    const body: Record<string, unknown> = {
      ...(verbose ? serializeQueryResult(result) : serializeMcpQueryResult(result)),
    }
    if (opts.requestId) body.requestId = opts.requestId
    // Sampled feedback nudge — trimmed payload only; the verbose payload has no
    // notes channel and verbose callers are debugging, not acting on answers.
    if (!verbose) {
      const rate = opts.feedbackSampleRate ?? readFeedbackSampleRate()
      const random = opts.random ?? Math.random
      if (rate > 0 && random() < rate) {
        const notes = Array.isArray(body.notes) ? (body.notes as string[]) : []
        body.notes = [...notes, feedbackNudge(opts.requestId)]
      }
    }
    return textResult(body)
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register `tools/list` and `tools/call` handlers backed by a `KbService`.
 * `kb_query` is `kb_`-prefixed to avoid collisions in multi-server clients.
 */
export function registerKbMcpHandlers(
  server: Server,
  service: KbService,
  opts: McpDispatchOptions = {}
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildMcpToolList(service),
  }))

  server.setRequestHandler(
    CallToolRequestSchema,
    async request =>
      dispatchMcpToolCall(
        service,
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        opts
      ) as Promise<CallToolResult>
  )
}
