import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpServer } from '../../src/server/http-server'
import type { KbService } from '../../src/server/kb-service'
import type { IntentResult } from '../../src/intents/types'
import {
  dispatchSlackEvent,
  verifySlackSignature,
  stripMentions,
  isDuplicateEvent,
} from '../../src/server/slack-handler'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-signing-secret'

function makeSlackSig(secret: string, ts: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000))
}

function makeStubService(overrides: Partial<KbService> = {}): KbService {
  return {
    baseDir: '/tmp/base',
    toolExecutor: {} as KbService['toolExecutor'],
    llmProvider: undefined,
    query: async (params): Promise<IntentResult> => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: {
        answer: `answer for: ${params.query}`,
        results: [],
        retrieval: { method: 'hybrid', detail: '' },
      },
    }),
    chat: async function* () {
      yield { type: 'answer' as const, text: 'chat answer', sources: [], factsRetrieved: 0 }
      yield { type: 'done' as const }
    },
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'scanned 1 repo(s)',
    isReindexing: () => false,
    waitForBootstrap: async () => {},
    health: () => ({ ok: true, base: 'base' }),
    close: async () => {},
    ...overrides,
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

async function slackPost(
  base: string,
  body: string,
  opts: { ts?: string; secret?: string; omitSig?: boolean } = {},
): Promise<Response> {
  const ts = opts.ts ?? nowTs()
  const secret = opts.secret ?? TEST_SECRET
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!opts.omitSig) {
    headers['x-slack-request-timestamp'] = ts
    headers['x-slack-signature'] = makeSlackSig(secret, ts, body)
  }
  return fetch(`${base}/slack/events`, { method: 'POST', headers, body })
}

// ---------------------------------------------------------------------------
// Unit tests — verifySlackSignature
// ---------------------------------------------------------------------------

describe('verifySlackSignature', () => {
  const ts = nowTs()
  const body = '{"type":"url_verification","challenge":"test"}'
  const goodSig = makeSlackSig(TEST_SECRET, ts, body)

                it('[TC-59] returns true for a valid signature', () => {
    expect(verifySlackSignature(TEST_SECRET, body, ts, goodSig)).toBe(true)
  })

                it('[TC-60] returns false when signature is wrong', () => {
    expect(verifySlackSignature(TEST_SECRET, body, ts, 'v0=badhash')).toBe(false)
  })

                it('[TC-61] returns false when timestamp is missing', () => {
    expect(verifySlackSignature(TEST_SECRET, body, undefined, goodSig)).toBe(false)
  })

                it('[TC-62] returns false when signature is missing', () => {
    expect(verifySlackSignature(TEST_SECRET, body, ts, undefined)).toBe(false)
  })

                it('[TC-63] returns false when timestamp is older than 5 minutes (replay attack)', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 301)
    const staleSig = makeSlackSig(TEST_SECRET, staleTs, body)
    expect(verifySlackSignature(TEST_SECRET, body, staleTs, staleSig)).toBe(false)
  })

                it('[TC-64] returns false when signing secret is wrong', () => {
    const wrongSig = makeSlackSig('other-secret', ts, body)
    expect(verifySlackSignature(TEST_SECRET, body, ts, wrongSig)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — stripMentions
// ---------------------------------------------------------------------------

describe('stripMentions', () => {
                it('[TC-65] strips a single leading mention', () => {
    expect(stripMentions('<@U0001> what is auth?')).toBe('what is auth?')
  })

                it('[TC-66] strips multiple leading mentions', () => {
    expect(stripMentions('<@U0001> <@U0002> hello')).toBe('hello')
  })

                it('[TC-67] leaves text unchanged when no mention is present', () => {
    expect(stripMentions('how does auth work?')).toBe('how does auth work?')
  })

                it('[TC-68] returns empty string when only a mention is present', () => {
    expect(stripMentions('<@U0001>')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Unit tests — isDuplicateEvent
// ---------------------------------------------------------------------------

describe('isDuplicateEvent', () => {
                it('[TC-69] returns false the first time an event_id is seen', () => {
    expect(isDuplicateEvent(`unique-${Date.now()}-a`)).toBe(false)
  })

                it('[TC-70] returns true for a repeated event_id', () => {
    const id = `unique-${Date.now()}-b`
    isDuplicateEvent(id)
    expect(isDuplicateEvent(id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — /slack/events HTTP surface
// ---------------------------------------------------------------------------

describe('POST /slack/events', () => {
  let server: Server | undefined

  const slackOpts = { signingSecret: TEST_SECRET, botToken: 'xoxb-test' }

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()))
      server = undefined
    }
  })

                it('[TC-71] rejects unsigned requests with 401', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const res = await slackPost(base, '{"type":"url_verification","challenge":"x"}', { omitSig: true })
    expect(res.status).toBe(401)
  })

                it('[TC-72] rejects requests with a wrong secret', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const res = await slackPost(base, '{"type":"url_verification","challenge":"x"}', { secret: 'wrong-secret' })
    expect(res.status).toBe(401)
  })

                it('[TC-73] rejects stale-timestamp requests', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const staleTs = String(Math.floor(Date.now() / 1000) - 400)
    const body = '{"type":"url_verification","challenge":"x"}'
    const res = await slackPost(base, body, { ts: staleTs })
    expect(res.status).toBe(401)
  })

                it('[TC-74] echoes the challenge for url_verification', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const body = JSON.stringify({ type: 'url_verification', challenge: 'kb-test-challenge' })
    const res = await slackPost(base, body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: 'kb-test-challenge' })
  })

                it('[TC-75] acks 200 for an app_mention event', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: `Ev-app-mention-${Date.now()}`,
      event: {
        type: 'app_mention',
        text: '<@U0001> what is authentication?',
        user: 'U0001',
        channel: 'C0001',
        ts: '1234567890.000001',
      },
    })
    const res = await slackPost(base, body)
    expect(res.status).toBe(200)
  })

                it('[TC-76] acks 200 for a DM message event', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: `Ev-dm-${Date.now()}`,
      event: {
        type: 'message',
        channel_type: 'im',
        text: 'how does auth work?',
        user: 'U0001',
        channel: 'D0001',
        ts: '1234567890.000002',
      },
    })
    const res = await slackPost(base, body)
    expect(res.status).toBe(200)
  })

                it('[TC-77] acks 200 for a threaded app_mention (chat mode)', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [], slack: slackOpts })
    const base = await listen(server)
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: `Ev-threaded-${Date.now()}`,
      event: {
        type: 'app_mention',
        text: '<@U0001> follow-up question',
        user: 'U0001',
        channel: 'C0001',
        ts: '1234567890.000003',
        thread_ts: '1234567890.000001',
      },
    })
    const res = await slackPost(base, body)
    expect(res.status).toBe(200)
  })

                it('[TC-78] ignores bot messages to prevent reply loops', async () => {
    const query = vi.fn()
    const botServer = createHttpServer({
      service: makeStubService({ query }),
      apiKeys: [],
      slack: slackOpts,
    })
    const base = await listen(botServer)
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: `Ev-bot-${Date.now()}`,
      event: {
        type: 'message',
        bot_id: 'B0001',
        text: 'bot reply text',
        channel: 'C0001',
        ts: '1234567890.000004',
      },
    })
    const res = await slackPost(base, body)
    expect(res.status).toBe(200)
    // Give async dispatch a tick to fire if it would.
    await new Promise(r => setTimeout(r, 20))
    expect(query).not.toHaveBeenCalled()
    await new Promise<void>(resolve => botServer.close(() => resolve()))
  })

                it('[TC-79] deduplicates events with the same event_id', async () => {
    const query = vi.fn(async (): Promise<IntentResult> => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: { answer: 'ok', results: [], retrieval: { method: 'hybrid', detail: '' } },
    }))
    const dedupServer = createHttpServer({
      service: makeStubService({ query }),
      apiKeys: [],
      slack: slackOpts,
    })
    const base = await listen(dedupServer)
    const eventId = `Ev-dedup-${Date.now()}-unique`
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: eventId,
      event: {
        type: 'app_mention',
        text: '<@U0001> hello',
        user: 'U0001',
        channel: 'C0001',
        ts: '1234567890.000005',
      },
    })
    await slackPost(base, body)
    await slackPost(base, body)
    // Allow async dispatch to run
    await new Promise(r => setTimeout(r, 50))
    // query should fire at most once despite two POST requests
    expect(query.mock.calls.length).toBeLessThanOrEqual(1)
    await new Promise<void>(resolve => dedupServer.close(() => resolve()))
  })

                it('[TC-80] returns 404 when slack is not configured', async () => {
    const noSlackServer = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(noSlackServer)
    const res = await fetch(`${base}/slack/events`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    await new Promise<void>(resolve => noSlackServer.close(() => resolve()))
  })
})

describe('dispatchSlackEvent bootstrap progress', () => {
                it('[TC-81] posts indexing progress first, then answers after bootstrap settles', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    let settleBootstrap!: () => void
    const bootstrapSettled = new Promise<void>(resolve => {
      settleBootstrap = resolve
    })
    let indexing = true
    const service = makeStubService({
      health: () => ({
        ok: true,
        base: 'base',
        ...(indexing
          ? {
              indexing: true,
              bootstrapProgress: '[init] @ catalog-service │ [========----------------] 2/6 document-facts 18/42 docs',
            }
          : {}),
      }),
      waitForBootstrap: async () => {
        await bootstrapSettled
      },
      chat: async function* () {
        yield { type: 'answer' as const, text: 'final answer', sources: [], factsRetrieved: 0 }
        yield { type: 'done' as const }
      },
    })

    const dispatch = dispatchSlackEvent(
      service,
      { signingSecret: TEST_SECRET, botToken: 'xoxb-test' },
      {
        type: 'event_callback',
        event_id: `Ev-bootstrap-${Date.now()}`,
        event: {
          type: 'app_mention',
          text: '<@U0001> hello',
          user: 'U0001',
          channel: 'C0001',
          ts: '1234567890.000101',
        },
      },
    )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as { text?: string }
    expect(firstPayload.text).toContain('KB is still indexing its knowledge base.')
    expect(firstPayload.text).toContain('catalog-service')
    expect(firstPayload.text).toContain('I will reply with the answer once indexing is complete.')

    indexing = false
    settleBootstrap()
    await dispatch

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}')) as { text?: string }
    expect(secondPayload.text).toBe('final answer')
  })
})
