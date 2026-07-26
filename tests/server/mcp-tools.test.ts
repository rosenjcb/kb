import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@kb/core/core/types.js'
import { buildMcpToolList, dispatchMcpToolCall } from '@kb/server/mcp-tools.js'
import { PendingFeedbackStore } from '@kb/server/pending-feedback-store.js'
import { QueryFeedbackStore } from '@kb/server/query-feedback-store.js'
import type { KbService } from '@kb/core/service/kb-service.js'

const registryTools: ToolDefinition[] = [
  { name: 'read_facts', description: 'Search facts', schema: { type: 'object', properties: {} } },
  { name: 'search_code_symbols', description: 'Search symbols', schema: { type: 'object', properties: {} } },
  { name: 'upsert_fact', description: 'Write a fact', schema: { type: 'object', properties: {} } },
]

function makeStubService(overrides: Partial<KbService> = {}): KbService {
  const execute = vi.fn(async () => ({ results: ['fact-1'] }))
  return {
    baseDir: '/tmp/base',
    toolExecutor: {
      getTools: () => registryTools,
      execute,
      register: () => {},
    },
    llmProvider: undefined,
    query: async params => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: {
        answer: `synth:${params.synthesize}`,
        results: [
          {
            metadata: {
              id: 'fact-1',
              title: 'Auth flow',
              sourcePath: 'src/auth/login.ts',
              symbol: 'loginHandler',
              tags: ['import_code', 'fact'],
            },
            content: 'Handles login.',
          },
        ],
        retrieval: { method: 'facts-loop', detail: 'passes:1;ponds:6;facts:104' },
      },
    }),
    chat: async function* () {
      yield { type: 'done' }
    },
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'ok',
    isReindexing: () => false,
    health: () => ({ ok: true, base: 'base' }),
    close: async () => {},
    ...overrides,
  }
}

describe('buildMcpToolList', () => {
  it('[TC-21] exposes exactly kb_query, submit_feedback, and get_feedback_requests, never allowlist tools or upsert_fact', () => {
    const tools = buildMcpToolList(makeStubService())
    const names = tools.map(t => t.name)
    expect(names).toEqual(['kb_query', 'submit_feedback', 'get_feedback_requests'])
  })
})

describe('dispatchMcpToolCall', () => {
  it('[TC-22] always synthesizes an answer (answer-first, no synthesize flag)', async () => {
    const service = makeStubService()
    const result = await dispatchMcpToolCall(service, 'kb_query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('"status": "accepted"')
    // The stub echoes params.synthesize into the answer; MCP must always pass true.
    expect(result.content[0].text).toContain('synth:true')
  })

  it('[TC-109] default response is answer + compact citations, no fact dump or retrieval metadata', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.answer).toBe('synth:true')
    expect(body.sources).toEqual(['src/auth/login.ts (loginHandler)'])
    // The noise the trimmed payload exists to drop:
    expect(body.retrieval).toBeUndefined()
    expect(body.results).toBeUndefined()
    expect(result.content[0].text).not.toContain('facts-loop')
    expect(result.content[0].text).not.toContain('snippet')
  })

  it('[TC-110] verbose:true opts into the full evidence payload', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', {
      q: 'auth',
      verbose: true,
    })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.answer).toBe('synth:true')
    expect(body.results).toHaveLength(1)
    expect(body.results[0].filePath).toBe('src/auth/login.ts')
    expect(body.retrieval).toEqual({ method: 'facts-loop', detail: 'passes:1;ponds:6;facts:104' })
  })

  it('[TC-109b] advertises the verbose flag in the tool schema', () => {
    const tools = buildMcpToolList(makeStubService())
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(['q', 'verbose'])
    expect(schema.required).toEqual(['q'])
  })

  it('[TC-23] errors when kb_query is missing q', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', {})
    expect(result.isError).toBe(true)
  })

  it('[TC-24] refuses former registry tools like kb_read_facts', async () => {
    const execute = vi.fn(async () => ({ results: ['fact-1'] }))
    const service = makeStubService({
      toolExecutor: { getTools: () => registryTools, execute, register: () => {} },
    })
    const result = await dispatchMcpToolCall(service, 'kb_read_facts', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Unknown or unavailable tool')
    expect(execute).not.toHaveBeenCalled()
  })

  it('[TC-25] refuses tools outside the allowlist', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_upsert_fact', { factText: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unavailable')
  })
})

describe('submit_feedback and feedback nudge', () => {
  function makeTempStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-feedback-'))
    return { dir, store: new QueryFeedbackStore(dir) }
  }

  it('[TC-129] records helped/notes/query/requestId/scores as an NDJSON record and returns ok', async () => {
    const { dir, store } = makeTempStore()
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      {
        helped: 'partial',
        notes: 'answer cited the right file but missed the retry path',
        query: 'how does auth retry work?',
        requestId: 'req-1',
        scores: { correctness: 3, usefulness: 2 },
      },
      { requestId: 'req-9', feedbackStore: store }
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).status).toBe('ok')
    const date = new Date().toISOString().slice(0, 10)
    const line = readFileSync(path.join(dir, `${date}.jsonl`), 'utf-8').trim()
    const record = JSON.parse(line)
    expect(record.source).toBe('mcp')
    expect(record.feedbackRequestId).toBe('req-9')
    expect(record.helped).toBe('partial')
    expect(record.notes).toContain('missed the retry path')
    expect(record.query).toBe('how does auth retry work?')
    expect(record.requestId).toBe('req-1')
    expect(record.scores).toEqual({ correctness: 3, usefulness: 2 })
    expect(record.ts).toBeTruthy()
  })

  it('[TC-130] errors when helped is missing or not yes/partial/no', async () => {
    const { store } = makeTempStore()
    const missing = await dispatchMcpToolCall(makeStubService(), 'submit_feedback', {}, { feedbackStore: store })
    expect(missing.isError).toBe(true)
    const invalid = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      { helped: 'kinda' },
      { feedbackStore: store }
    )
    expect(invalid.isError).toBe(true)
    expect(invalid.content[0].text).toContain('helped')
  })

  it('[TC-131] kb_query payload echoes the server requestId for feedback correlation', async () => {
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'kb_query',
      { q: 'auth' },
      { requestId: 'req-42' }
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).requestId).toBe('req-42')
  })

  it('[TC-132] sets a top-level AGENT_INSTRUCTION nudge (not buried in notes) when the sampling gate passes', async () => {
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'kb_query',
      { q: 'auth' },
      { requestId: 'req-7', feedbackSampleRate: 1, random: () => 0 }
    )
    const body = JSON.parse(result.content[0].text)
    expect(typeof body.AGENT_INSTRUCTION).toBe('string')
    expect(body.AGENT_INSTRUCTION).toContain('submit_feedback')
    expect(body.AGENT_INSTRUCTION).toContain('req-7')
    if (Array.isArray(body.notes)) {
      expect(body.notes.some((n: string) => n.includes('submit_feedback'))).toBe(false)
    }
  })

  it('[TC-133] sets no AGENT_INSTRUCTION when KB_FEEDBACK_SAMPLE_RATE is unset or 0 (default off)', async () => {
    vi.stubEnv('KB_FEEDBACK_SAMPLE_RATE', '')
    try {
      const unset = await dispatchMcpToolCall(makeStubService(), 'kb_query', { q: 'auth' })
      expect(JSON.parse(unset.content[0].text).AGENT_INSTRUCTION).toBeUndefined()
      const zero = await dispatchMcpToolCall(
        makeStubService(),
        'kb_query',
        { q: 'auth' },
        { feedbackSampleRate: 0, random: () => 0 }
      )
      expect(JSON.parse(zero.content[0].text).AGENT_INSTRUCTION).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('[TC-134] kb_query response echoes back the original query text', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', { q: 'how does auth retry work?' })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).query).toBe('how does auth retry work?')
  })

  it('[TC-135] submit_feedback response echoes back the submitted query when provided, omits it when absent', async () => {
    const { store } = makeTempStore()
    const withQuery = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      { helped: 'yes', query: 'how does auth retry work?' },
      { feedbackStore: store }
    )
    expect(JSON.parse(withQuery.content[0].text).query).toBe('how does auth retry work?')

    const withoutQuery = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      { helped: 'yes' },
      { feedbackStore: store }
    )
    expect(JSON.parse(withoutQuery.content[0].text).query).toBeUndefined()
  })

  it('[TC-137] submit_feedback response echoes the full recorded feedback, not just query', async () => {
    const { store } = makeTempStore()
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      {
        helped: 'partial',
        notes: 'missed the retry path',
        requestId: 'req-1',
        scores: { correctness: 3 },
      },
      { feedbackStore: store }
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.helped).toBe('partial')
    expect(body.notes).toBe('missed the retry path')
    expect(body.requestId).toBe('req-1')
    expect(body.scores).toEqual({ correctness: 3 })
  })

  it('[TC-138] submit_feedback rejects a non-string requestId (no array batching)', async () => {
    const { store } = makeTempStore()
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      { helped: 'yes', requestId: ['req-1', 'req-2'] },
      { feedbackStore: store }
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('requestId')
  })

  it('[TC-139] get_feedback_requests lists a pending entry queued by a sampled nudge, and submit_feedback resolves it', async () => {
    const service = makeStubService()
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { store: feedbackStore } = makeTempStore()

    const queried = await dispatchMcpToolCall(
      service,
      'kb_query',
      { q: 'how does auth retry work?' },
      { requestId: 'req-5', feedbackSampleRate: 1, random: () => 0, pendingFeedbackStore }
    )
    expect(JSON.parse(queried.content[0].text).AGENT_INSTRUCTION).toContain('req-5')

    const pendingBefore = await dispatchMcpToolCall(service, 'get_feedback_requests', {}, { pendingFeedbackStore })
    expect(JSON.parse(pendingBefore.content[0].text).pending).toEqual([
      expect.objectContaining({ requestId: 'req-5', query: 'how does auth retry work?' }),
    ])

    await dispatchMcpToolCall(
      service,
      'submit_feedback',
      { helped: 'yes', requestId: 'req-5' },
      { feedbackStore, pendingFeedbackStore }
    )

    const pendingAfter = await dispatchMcpToolCall(service, 'get_feedback_requests', {}, { pendingFeedbackStore })
    expect(JSON.parse(pendingAfter.content[0].text).pending).toEqual([])
  })

  it('[TC-140] submit_feedback with no requestId is valid general feedback and leaves the pending queue untouched', async () => {
    const service = makeStubService()
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { store: feedbackStore } = makeTempStore()

    await dispatchMcpToolCall(
      service,
      'kb_query',
      { q: 'auth' },
      { requestId: 'req-6', feedbackSampleRate: 1, random: () => 0, pendingFeedbackStore }
    )
    const result = await dispatchMcpToolCall(
      service,
      'submit_feedback',
      { helped: 'yes', notes: 'general note, not about a specific query' },
      { feedbackStore, pendingFeedbackStore }
    )
    expect(result.isError).toBeUndefined()
    const pending = await dispatchMcpToolCall(service, 'get_feedback_requests', {}, { pendingFeedbackStore })
    expect(JSON.parse(pending.content[0].text).pending).toEqual([
      expect.objectContaining({ requestId: 'req-6' }),
    ])
  })
})
