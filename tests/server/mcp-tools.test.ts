import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@kb/core/core/types.js'
import { buildMcpToolList, dispatchMcpToolCall } from '@kb/server/mcp-tools.js'
import { PendingFeedbackStore } from '@kb/server/pending-feedback-store.js'
import { QueryFeedbackStore } from '@kb/server/query-feedback-store.js'
import { BaseNotFoundError, type KbServiceRegistry } from '@kb/server/service-registry.js'
import type { KbService } from '@kb/core/service/kb-service.js'

const registryTools: ToolDefinition[] = [
  { name: 'read_facts', description: 'Search facts', schema: { type: 'object', properties: {} } },
  {
    name: 'search_code_symbols',
    description: 'Search symbols',
    schema: { type: 'object', properties: {} },
  },
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
  it('[TC-NFCZ] exposes exactly query, submit_feedback, and get_feedback_requests, never allowlist tools or upsert_fact', () => {
    const tools = buildMcpToolList(makeStubService())
    const names = tools.map(t => t.name)
    expect(names).toEqual(['query', 'submit_feedback', 'get_feedback_requests'])
  })
})

describe('dispatchMcpToolCall', () => {
  it('[TC-3391] always synthesizes an answer (answer-first, no synthesize flag)', async () => {
    const service = makeStubService()
    const result = await dispatchMcpToolCall(service, 'query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('"status": "accepted"')
    // The stub echoes params.synthesize into the answer; MCP must always pass true.
    expect(result.content[0].text).toContain('synth:true')
  })

  it('[TC-741S] default response is answer + lean citations, no fact dump or retrieval metadata', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.answer).toBe('synth:true')
    expect(body.base).toBe('base')
    expect(body.sources).toEqual([
      { path: 'src/auth/login.ts', relPath: 'src/auth/login.ts', symbols: ['loginHandler'] },
    ])
    // The noise the trimmed payload exists to drop:
    expect(body.retrieval).toBeUndefined()
    expect(body.results).toBeUndefined()
    expect(result.content[0].text).not.toContain('facts-loop')
    expect(result.content[0].text).not.toContain('snippet')
    expect(result.content[0].text).not.toContain('factCount')
  })

  it('[TC-B233] echoes the served base so agents can detect wrong-base routing', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'query', { q: 'auth' })
    const body = JSON.parse(result.content[0].text)
    expect(body.base).toBe('base')
  })

  it('[TC-ONSY] verbose:true opts into the full evidence payload', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'query', {
      q: 'auth',
      verbose: true,
    })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.answer).toBe('synth:true')
    expect(body.results).toHaveLength(1)
    expect(body.results[0].filePath).toBe('src/auth/login.ts')
    expect(body.retrieval).toEqual({ method: 'facts-loop', detail: 'passes:1;ponds:6;facts:104' })
    expect(body.sources[0]).toMatchObject({
      path: 'src/auth/login.ts',
      symbols: ['loginHandler'],
      factCount: 1,
    })
  })

  it('[TC-O6P7] advertises the verbose and base flags in the tool schema', () => {
    const tools = buildMcpToolList(makeStubService())
    const schema = tools[0].inputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(Object.keys(schema.properties)).toEqual(['q', 'verbose', 'base'])
    expect(schema.required).toEqual(['q'])
  })

  it('[TC-XZYJ] errors when query is missing q', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'query', {})
    expect(result.isError).toBe(true)
  })

  it('[TC-ILZU] refuses former registry tools like kb_read_facts', async () => {
    const execute = vi.fn(async () => ({ results: ['fact-1'] }))
    const service = makeStubService({
      toolExecutor: { getTools: () => registryTools, execute, register: () => {} },
    })
    const result = await dispatchMcpToolCall(service, 'kb_read_facts', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Unknown or unavailable tool')
    expect(execute).not.toHaveBeenCalled()
  })

  it('[TC-OYMN] refuses tools outside the allowlist', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_upsert_fact', { factText: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unavailable')
  })

  function makeStubRegistry(overrides: Partial<KbServiceRegistry> = {}): KbServiceRegistry {
    return {
      defaultBaseName: 'base',
      resolve: () => {
        throw new BaseNotFoundError('unset')
      },
      list: async () => [],
      closeAll: async () => {},
      ...overrides,
    }
  }

  it('[TC-8NCJ] base argument resolves the named base via the registry instead of the session default', async () => {
    const sessionDefault = makeStubService()
    const otherBase = makeStubService({
      query: async params => ({
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: { answer: `other-base:${params.query}`, results: [], retrieval: { method: 'hybrid' } },
      }),
    })
    const registry = makeStubRegistry({
      resolve: slug => {
        if (slug === 'raylib') return otherBase
        throw new BaseNotFoundError(slug ?? '')
      },
    })
    const result = await dispatchMcpToolCall(
      sessionDefault,
      'query',
      { q: 'auth', base: 'raylib' },
      { registry }
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).answer).toBe('other-base:auth')
  })

  it('[TC-QCMR] errors (not a 404) when base names a slug the registry can\'t resolve', async () => {
    const registry = makeStubRegistry({
      resolve: slug => {
        throw new BaseNotFoundError(slug ?? '')
      },
    })
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'query',
      { q: 'auth', base: 'nope' },
      { registry }
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unknown base "nope"')
  })

  it('[TC-01LO] ignores a base argument when no registry is configured (single-base server)', async () => {
    const service = makeStubService()
    const result = await dispatchMcpToolCall(service, 'query', { q: 'auth', base: 'raylib' })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).answer).toBe('synth:true')
  })
})

describe('submit_feedback and feedback nudge', () => {
  function makeTempStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-feedback-'))
    return { dir, store: new QueryFeedbackStore(dir) }
  }

  it('[TC-W2FJ] records helped/notes/query/requestId/scores as an NDJSON record and returns ok', async () => {
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

  it('[TC-ZOLQ] errors when helped is missing or not yes/partial/no', async () => {
    const { store } = makeTempStore()
    const missing = await dispatchMcpToolCall(
      makeStubService(),
      'submit_feedback',
      {},
      { feedbackStore: store }
    )
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

  it('[TC-AYDQ] query payload echoes the server requestId for feedback correlation', async () => {
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'query',
      { q: 'auth' },
      { requestId: 'req-42' }
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).requestId).toBe('req-42')
  })

  it('[TC-K557] sets a top-level AGENT_INSTRUCTION nudge (not buried in notes) when the sampling gate passes', async () => {
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'query',
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

  it('[TC-7NV4] sets no AGENT_INSTRUCTION when KB_FEEDBACK_SAMPLE_RATE is unset or 0 (default off)', async () => {
    vi.stubEnv('KB_FEEDBACK_SAMPLE_RATE', '')
    try {
      const unset = await dispatchMcpToolCall(makeStubService(), 'query', { q: 'auth' })
      expect(JSON.parse(unset.content[0].text).AGENT_INSTRUCTION).toBeUndefined()
      const zero = await dispatchMcpToolCall(
        makeStubService(),
        'query',
        { q: 'auth' },
        { feedbackSampleRate: 0, random: () => 0 }
      )
      expect(JSON.parse(zero.content[0].text).AGENT_INSTRUCTION).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('[TC-EHKV] query response echoes back the original query text', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'query', {
      q: 'how does auth retry work?',
    })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).query).toBe('how does auth retry work?')
  })

  it('[TC-ZI7U] submit_feedback response echoes back the submitted query when provided, omits it when absent', async () => {
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

  it('[TC-CZ3E] submit_feedback response echoes the full recorded feedback, not just query', async () => {
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

  it('[TC-ULOC] submit_feedback rejects a non-string requestId (no array batching)', async () => {
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

  it('[TC-KYRN] get_feedback_requests lists a pending entry queued by a sampled nudge, and submit_feedback resolves it', async () => {
    const service = makeStubService()
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { store: feedbackStore } = makeTempStore()

    const queried = await dispatchMcpToolCall(
      service,
      'query',
      { q: 'how does auth retry work?' },
      { requestId: 'req-5', feedbackSampleRate: 1, random: () => 0, pendingFeedbackStore }
    )
    expect(JSON.parse(queried.content[0].text).AGENT_INSTRUCTION).toContain('req-5')

    const pendingBefore = await dispatchMcpToolCall(
      service,
      'get_feedback_requests',
      {},
      { pendingFeedbackStore }
    )
    expect(JSON.parse(pendingBefore.content[0].text).pending).toEqual([
      expect.objectContaining({ requestId: 'req-5', query: 'how does auth retry work?' }),
    ])

    await dispatchMcpToolCall(
      service,
      'submit_feedback',
      { helped: 'yes', requestId: 'req-5' },
      { feedbackStore, pendingFeedbackStore }
    )

    const pendingAfter = await dispatchMcpToolCall(
      service,
      'get_feedback_requests',
      {},
      { pendingFeedbackStore }
    )
    expect(JSON.parse(pendingAfter.content[0].text).pending).toEqual([])
  })

  it('[TC-BZZH] submit_feedback with no requestId is valid general feedback and leaves the pending queue untouched', async () => {
    const service = makeStubService()
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { store: feedbackStore } = makeTempStore()

    await dispatchMcpToolCall(
      service,
      'query',
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
    const pending = await dispatchMcpToolCall(
      service,
      'get_feedback_requests',
      {},
      { pendingFeedbackStore }
    )
    expect(JSON.parse(pending.content[0].text).pending).toEqual([
      expect.objectContaining({ requestId: 'req-6' }),
    ])
  })

  it('[TC-1SRC] elicitFeedback accept records feedback via elicitation and skips AGENT_INSTRUCTION/pending', async () => {
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { dir, store: feedbackStore } = makeTempStore()
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'query',
      { q: 'how does auth retry work?' },
      {
        requestId: 'req-elicit-1',
        feedbackSampleRate: 1,
        random: () => 0,
        pendingFeedbackStore,
        feedbackStore,
        elicitFeedback: async () => ({
          kind: 'accepted',
          helped: 'partial',
          notes: 'missed the retry path',
        }),
      }
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.AGENT_INSTRUCTION).toBeUndefined()
    expect(body.feedback).toEqual({
      status: 'recorded',
      via: 'elicitation',
      helped: 'partial',
      notes: 'missed the retry path',
    })
    expect(pendingFeedbackStore.list()).toEqual([])
    const date = new Date().toISOString().slice(0, 10)
    const record = JSON.parse(readFileSync(path.join(dir, `${date}.jsonl`), 'utf-8').trim())
    expect(record.helped).toBe('partial')
    expect(record.requestId).toBe('req-elicit-1')
    expect(record.query).toBe('how does auth retry work?')
    expect(record.notes).toBe('missed the retry path')
  })

  it('[TC-M9E1] elicitFeedback decline/cancel skips recording and AGENT_INSTRUCTION but still queues pending', async () => {
    const pendingFeedbackStore = new PendingFeedbackStore()
    const { dir, store: feedbackStore } = makeTempStore()
    const declined = await dispatchMcpToolCall(
      makeStubService(),
      'query',
      { q: 'auth' },
      {
        requestId: 'req-elicit-2',
        feedbackSampleRate: 1,
        random: () => 0,
        pendingFeedbackStore,
        feedbackStore,
        elicitFeedback: async () => ({ kind: 'dismissed', action: 'decline' }),
      }
    )
    const body = JSON.parse(declined.content[0].text)
    expect(body.AGENT_INSTRUCTION).toBeUndefined()
    expect(body.feedback).toEqual({ status: 'decline', via: 'elicitation' })
    // Dismissed (whether a genuine human decline or a client auto-declining because it has no
    // UI to render a form in this session) must not lose the sample — it stays discoverable via
    // get_feedback_requests so a later checkpoint can still close the loop.
    expect(pendingFeedbackStore.list()).toEqual([
      expect.objectContaining({ requestId: 'req-elicit-2', query: 'auth' }),
    ])
    const date = new Date().toISOString().slice(0, 10)
    expect(() => readFileSync(path.join(dir, `${date}.jsonl`), 'utf-8')).toThrow()
  })

  it('[TC-PIQZ] elicitFeedback unavailable falls back to AGENT_INSTRUCTION + pending', async () => {
    const pendingFeedbackStore = new PendingFeedbackStore()
    const result = await dispatchMcpToolCall(
      makeStubService(),
      'query',
      { q: 'auth' },
      {
        requestId: 'req-elicit-3',
        feedbackSampleRate: 1,
        random: () => 0,
        pendingFeedbackStore,
        elicitFeedback: async () => ({ kind: 'unavailable' }),
      }
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.AGENT_INSTRUCTION).toContain('submit_feedback')
    expect(body.feedback).toBeUndefined()
    expect(pendingFeedbackStore.list()).toEqual([
      expect.objectContaining({ requestId: 'req-elicit-3' }),
    ])
  })
})

describe('query synthesis failure', () => {
  const failingService = () =>
    makeStubService({
      query: async () => ({
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          answerError: {
            stage: 'synthesis',
            kind: 'insufficient_credits',
            message: '[anthropic] API request failed (400): Your credit balance is too low',
            provider: 'anthropic',
            status: 400,
            retryable: false,
          },
          results: [
            {
              metadata: { id: 'fact-1', title: 'Auth flow', sourcePath: 'src/auth/login.ts' },
              content: 'Handles login.',
            },
          ],
          retrieval: { method: 'facts-loop' },
        },
      }),
    })

  it('[TC-ZVKA] Given synthesis failed, then query reports answerError rather than an empty answer', async () => {
    const result = await dispatchMcpToolCall(failingService(), 'query', { q: 'auth' })
    const body = JSON.parse(result.content[0].text)
    expect(body.answer).toBeNull()
    expect(body.answerError.kind).toBe('insufficient_credits')
    expect(body.notes[0]).toContain('Answer synthesis failed')
    // Sources still ship — retrieval worked, only the answer-writing step failed.
    expect(body.sources).toEqual([{ path: 'src/auth/login.ts', relPath: 'src/auth/login.ts' }])
  })

  it('[TC-RBLQ] Given synthesis failed, then no feedback is solicited for the missing answer', async () => {
    // Sampling forced on: without the guard this would ask an agent to rate an answer
    // that never existed, scoring a provider outage as a KB quality problem.
    const result = await dispatchMcpToolCall(
      failingService(),
      'query',
      { q: 'auth' },
      {
        feedbackSampleRate: 1,
        random: () => 0,
        requestId: 'req-1',
      }
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.AGENT_INSTRUCTION).toBeUndefined()
    expect(body.feedback).toBeUndefined()
  })
})
