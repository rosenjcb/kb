import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { IntentResult } from '../../src/intents/types'
import { createHttpServer } from '../../src/server/http-server'
import type { KbService } from '../../src/server/kb-service'

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
        results: [{ metadata: { id: 'd1', title: 'Doc' }, content: 'evidence line' }],
        retrieval: { method: 'hybrid', detail: 'deep' },
      },
    }),
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'scanned 1 repo(s)',
    isReindexing: () => false,
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

let server: Server | undefined

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

describe('createHttpServer', () => {
  it('serves /healthz without auth', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, base: 'base' })
  })

  it('rejects /v1/query without a valid key', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(res.status).toBe(401)
  })

  it('answers /v1/query with a serialized body when authorized', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ q: 'how does auth work' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.answer).toBe('answer for: how does auth work')
    expect(body.results[0]).toMatchObject({ id: 'd1', title: 'Doc' })
    expect(body.retrieval).toEqual({ method: 'hybrid', detail: 'deep' })
  })

  it('returns 400 when q is missing', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 when a reindex is already running', async () => {
    server = createHttpServer({
      service: makeStubService({ isReindexing: () => true }),
      apiKeys: [],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/reindex`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('triggers reindex and returns the summary', async () => {
    const reindex = vi.fn(async () => 'scanned 2 repo(s)')
    server = createHttpServer({ service: makeStubService({ reindex }), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/reindex`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', summary: 'scanned 2 repo(s)' })
    expect(reindex).toHaveBeenCalledOnce()
  })

  it('404s on unknown routes and when MCP is disabled', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
    expect(mcp.status).toBe(404)
  })
})
