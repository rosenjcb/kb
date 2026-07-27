import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KbService } from '@kb/core/service/kb-service.js'
import { handleMcpHttpRequest, resetMcpSessionsForTests } from '@kb/server/mcp-server.js'
import { afterEach, describe, expect, it } from 'vitest'

function makeStubService(): KbService {
  return {
    baseDir: '/tmp/base',
    toolExecutor: { getTools: () => [], execute: async () => ({}), register: () => {} },
    llmProvider: undefined,
    query: async () => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: { answer: null, results: [] },
    }),
    chat: async function* () {
      yield { type: 'done' }
    },
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'ok',
    isReindexing: () => false,
    health: () => ({ ok: true, base: 'base' }),
    close: async () => {},
  } as unknown as KbService
}

function mockRes(): ServerResponse & {
  statusCode?: number
  body?: string
  headers?: Record<string, string>
} {
  const res = new EventEmitter() as ServerResponse & {
    statusCode?: number
    body?: string
    headers?: Record<string, string>
    headersSent: boolean
  }
  res.headersSent = false
  res.headers = {}
  res.writeHead = ((code: number, headers?: Record<string, string>) => {
    res.statusCode = code
    res.headers = { ...res.headers, ...(headers ?? {}) }
    res.headersSent = true
    return res
  }) as ServerResponse['writeHead']
  res.end = ((chunk?: unknown) => {
    if (chunk !== undefined) res.body = String(chunk)
    return res
  }) as ServerResponse['end']
  return res
}

function mockReq(method: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.method = method
  req.headers = headers
  return req
}

describe('handleMcpHttpRequest sessions', () => {
  afterEach(() => {
    resetMcpSessionsForTests()
  })

  it('[TC-145] rejects POST tools/list without mcp-session-id (must initialize first)', async () => {
    const res = mockRes()
    await handleMcpHttpRequest(
      makeStubService(),
      mockReq('POST'),
      res,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { elicitationEnabled: false }
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('No valid MCP session ID')
  })

  it('[TC-145] rejects GET without mcp-session-id', async () => {
    const res = mockRes()
    await handleMcpHttpRequest(makeStubService(), mockReq('GET'), res, undefined, {
      elicitationEnabled: false,
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Invalid or missing MCP session ID')
  })
})
