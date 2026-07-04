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
        results: [{ metadata: { id: 'd1', title: 'Doc' }, content: 'evidence line' }],
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
                it('[TC-3] serves /healthz without auth', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, base: 'base' })
  })

                it('[TC-4] rejects /v1/query without a valid key', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: ['secret'] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(res.status).toBe(401)
  })

                it('[TC-5] answers /v1/query with a serialized body when authorized', async () => {
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

                it('[TC-6] returns 503 for /v1/query while the server is bootstrapping its first index', async () => {
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

                it('[TC-7] returns 400 when q is missing', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

                it('[TC-8] returns 409 when a reindex is already running', async () => {
    server = createHttpServer({
      service: makeStubService({ isReindexing: () => true }),
      apiKeys: [],
    })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/reindex`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

                it('[TC-9] triggers reindex and returns the summary', async () => {
    const reindex = vi.fn(async () => 'scanned 2 repo(s)')
    server = createHttpServer({ service: makeStubService({ reindex }), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/reindex`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', summary: 'scanned 2 repo(s)' })
    expect(reindex).toHaveBeenCalledOnce()
  })

                it('[TC-10] streams /v1/chat as SSE with a session id, answer, and done', async () => {
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

                it('[TC-11] returns 400 when chat message is missing', async () => {
    server = createHttpServer({ service: makeStubService(), apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

                it('[TC-12] 404s on unknown routes and when MCP is disabled', async () => {
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

                it('[TC-13] writes a RunReport to disk for /v1/query', async () => {
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
    expect(report.command).toBe('server.query')
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
    expect(parsed.command).toBe('server.query')
    expect(parsed.status).toBe('success')
  })

                it('[TC-14] writes an error RunReport when /v1/query fails', async () => {
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
    expect(report.command).toBe('server.query')
    expect(report.status).toBe('error')
    expect(report.errorMessage).toBe('llm unavailable')
  })

                it('[TC-15] does not write a RunReport for /healthz', async () => {
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
})
