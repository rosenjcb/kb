import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { IntentResult } from '@kb/core/intents/types.js'
import { createHttpServer } from '@kb/server/http-server.js'
import type { KbService } from '@kb/core/service/kb-service.js'
import type { RunReport } from '@kb/core/core/telemetry.js'

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
        results: [
          {
            metadata: {
              id: 'd1',
              title: 'Doc',
              sourcePath: 'src/docs/auth.md',
              symbol: 'AuthDoc',
            },
            content: 'evidence line',
          },
        ],
        retrieval: { method: 'hybrid', detail: 'deep' },
      },
    }),
    chat: async function* () {
      yield { type: 'answer', text: 'chat answer', sources: [], factsRetrieved: 0 }
      yield { type: 'done' }
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

let server: Server | undefined

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

describe('createHttpServer', () => {
                it('[TC-HTRQ] serves /healthz without auth', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, base: 'base' })
    expect(body.version).toEqual({
      server: expect.stringMatching(/^\d+\.\d+\.\d+/),
    })
  })

                it('[TC-CASW] returns 200 on /healthz while bootstrap indexing (liveness; ok=false in body)', async () => {
    server = createHttpServer({
      service: makeStubService({
        health: () => ({
          ok: false,
          base: 'base',
          indexing: true,
          bootstrapProgress: '[init] building index…',
        }),
      }),
      apiKeys: [],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: false,
      indexing: true,
      bootstrapProgress: '[init] building index…',
    })
  })

                it('[TC-2DUM] rejects /v1/query without a valid key', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(res.status).toBe(401)
  })

                it('[TC-BY16] answers /v1/query with a serialized body when authorized', async () => {
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
    // Default is the lean agent payload — no fact dump or retrieval telemetry.
    expect(body.sources).toEqual([{ path: 'src/docs/auth.md', symbols: ['AuthDoc'] }])
    expect(body.results).toBeUndefined()
    expect(body.retrieval).toBeUndefined()
  })

  it('[TC-SY60] REST verbose:true returns the full evidence dump', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ q: 'how does auth work', verbose: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ id: 'd1', title: 'Doc', filePath: 'src/docs/auth.md' })
    expect(body.retrieval).toEqual({ method: 'hybrid', detail: 'deep' })
    expect(body.sources[0]).toMatchObject({
      path: 'src/docs/auth.md',
      symbols: ['AuthDoc'],
      factCount: 1,
    })
  })

                it('[TC-B7TH] forwards trace: true to the service query pipeline', async () => {
    const query = vi.fn(makeStubService().query)
    server = createHttpServer({ service: makeStubService({ query }), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'trace me', trace: true }),
    })
    expect(res.status).toBe(200)
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ query: 'trace me', trace: true }))
  })

                it('[TC-F9NB] serves /v1/query while scheduled reindex is in progress (not bootstrap)', async () => {
    const query = vi.fn(makeStubService().query)
    server = createHttpServer({
      service: makeStubService({
        query,
        isReindexing: () => true,
        health: () => ({
          ok: true,
          base: 'base',
          reindexing: true,
          indexMtime: '2026-07-18T00:00:00.000Z',
        }),
      }),
      apiKeys: [],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'how does auth work?' }),
    })
    expect(res.status).toBe(200)
    expect(query).toHaveBeenCalled()
  })

                it('[TC-RRE8] returns 503 for /v1/query while the server is bootstrapping its first index', async () => {
    const query = vi.fn(makeStubService().query)
    server = createHttpServer({
      service: makeStubService({
        query,
        health: () => ({
          ok: true,
          base: 'base',
          indexing: true,
          bootstrapProgress: '[init] @ catalog-service │ [========----------------] 2/6 document-facts 18/42 docs',
        }),
      }),
      apiKeys: [],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'how does auth work' }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'server is indexing its knowledge base; try again soon',
      status: 'indexing',
      progress: '[init] @ catalog-service │ [========----------------] 2/6 document-facts 18/42 docs',
    })
    expect(query).not.toHaveBeenCalled()
  })

                it('[TC-ZXE4] returns 400 when q is missing', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

                it('[TC-E2AA] streams /v1/chat as SSE with a session id, answer, and done', async () => {
    server = createHttpServer({
      service: makeStubService({
        chat: async function* () {
          yield { type: 'reasoning', text: 'thinking' }
          yield { type: 'answer', text: 'hello there', sources: [], factsRetrieved: 0 }
          yield { type: 'done' }
        },
      }),
      apiKeys: ['secret'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: session')
    expect(text).toContain('event: reasoning')
    expect(text).toContain('event: answer')
    expect(text).toContain('hello there')
    expect(text.trimEnd().endsWith('event: done\ndata: {"type":"done"}')).toBe(true)
  })

                it('[TC-UHQY] returns 400 when chat message is missing', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

                it('[TC-G9U9] 404s on unknown routes and when MCP is disabled', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
    expect(mcp.status).toBe(404)
  })
})

describe('server-side run report capture', () => {
  let logsDir: string

  beforeEach(async () => {
    logsDir = await mkdtemp(path.join(os.tmpdir(), 'kb-server-logs-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()))
      server = undefined
    }
    await rm(logsDir, { recursive: true, force: true })
  })

                it('[TC-O3AH] writes a RunReport to disk for /v1/query', async () => {
    let resolveReport!: (r: RunReport) => void
    const reportWritten = new Promise<RunReport>(resolve => { resolveReport = resolve })

    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      logsDir,
      onReportWritten: resolveReport,
    })
    const base = await listen(server)

    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'what is kb' }),
    })
    expect(res.status).toBe(200)

    const report = await reportWritten
    expect(report.command).toBe('query')
    expect(report.status).toBe('success')
    expect(report.base).toBe('base')
    expect(report.runId).toMatch(/^run-\d+-\w+$/)
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(0)
    expect(report.stages).toEqual([])

    // Verify the report was actually persisted on disk
    const files = await readdir(logsDir)
    const jsonlFile = files.find(f => f.endsWith('.jsonl')) ?? ''
    expect(jsonlFile).toBeTruthy()
    const text = await readFile(path.join(logsDir, jsonlFile), 'utf-8')
    const parsed = JSON.parse(text.trim()) as RunReport
    expect(parsed.command).toBe('query')
    expect(parsed.status).toBe('success')
  })

                it('[TC-C18R] writes an error RunReport when /v1/query fails', async () => {
    let resolveReport!: (r: RunReport) => void
    const reportWritten = new Promise<RunReport>(resolve => { resolveReport = resolve })

    server = createHttpServer({
      service: makeStubService({ query: async () => { throw new Error('llm unavailable') } }),
      apiKeys: [],
      logsDir,
      onReportWritten: resolveReport,
    })
    const base = await listen(server)

    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'what is kb' }),
    })
    expect(res.status).toBe(500)

    const report = await reportWritten
    expect(report.command).toBe('query')
    expect(report.status).toBe('error')
    expect(report.errorMessage).toBe('llm unavailable')
  })

                it('[TC-CESD] a /v1/chat turn writes a report whose turns hold the user message and assistant answer', async () => {
    let resolveReport!: (r: RunReport) => void
    const reportWritten = new Promise<RunReport>(resolve => { resolveReport = resolve })

    server = createHttpServer({
      service: makeStubService({
        chat: async function* () {
          yield { type: 'answer', text: 'the answer is 42', sources: [], factsRetrieved: 0 }
          yield { type: 'done' }
        },
      }),
      apiKeys: [],
      logsDir,
      onReportWritten: resolveReport,
    })
    const base = await listen(server)

    const res = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what is the answer?' }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const report = await reportWritten
    expect(report.command).toBe('chat')
    expect(report.turns).toEqual([
      { role: 'user', text: 'what is the answer?' },
      { role: 'assistant', text: 'the answer is 42' },
    ])
  })

                it('[TC-PFPE] does not write a RunReport for /healthz', async () => {
    const reports: RunReport[] = []
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      logsDir,
      onReportWritten: r => reports.push(r),
    })
    const base = await listen(server)

    await fetch(`${base}/healthz`)
    // Give async report writer a chance to fire (if it incorrectly does)
    await new Promise(r => setTimeout(r, 30))
    expect(reports).toHaveLength(0)
  })

                it('[TC-7GMP] omits CORS headers when no origins are allowed', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`, { headers: { origin: 'https://example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

                it('[TC-6U7T] reflects an allow-listed origin and varies on Origin', async () => {
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      allowedOrigins: ['https://rosenjcb.github.io'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://rosenjcb.github.io' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rosenjcb.github.io')
    expect(res.headers.get('vary')).toContain('Origin')
  })

                it('[TC-7IKA] does not reflect an origin outside the allow-list', async () => {
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      allowedOrigins: ['https://rosenjcb.github.io'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

                it('[TC-TIO4] echoes * when any origin is allowed', async () => {
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      allowedOrigins: ['*'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`, { headers: { origin: 'https://anything.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

                it('[TC-8YQ4] answers preflight OPTIONS with 204 and no auth for an allowed origin', async () => {
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: ['secret'],
      allowedOrigins: ['https://rosenjcb.github.io'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/chat`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://rosenjcb.github.io',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rosenjcb.github.io')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
  })

                it('[TC-VMNX] rejects preflight OPTIONS from a disallowed origin with 405', async () => {
    server = createHttpServer({
      service: makeStubService(),
      apiKeys: [],
      allowedOrigins: ['https://rosenjcb.github.io'],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/chat`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
