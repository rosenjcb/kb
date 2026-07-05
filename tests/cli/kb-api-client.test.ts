import { describe, expect, it, vi } from 'vitest'
import { KbApiClient } from '@kb/client/api/kb-api-client.js'
import { formatConnectionError } from '@kb/client/api/connection-error.js'
import { resolveServerConnection } from '@kb/client/api/server-connection.js'

describe('server-connection', () => {
  it('[TC-1] resolves KBHOST/KBPORT defaults to localhost:38117', () => {
    const prevHost = process.env.KBHOST
    const prevPort = process.env.KBPORT
    delete process.env.KBHOST
    delete process.env.KBPORT
    delete process.env.KB_SERVER_URL
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('http://localhost:38117')
    if (prevHost) process.env.KBHOST = prevHost
    if (prevPort) process.env.KBPORT = prevPort
  })

  it('[TC-2] prefers KB_SERVER_URL override', () => {
    const prev = process.env.KB_SERVER_URL
    process.env.KB_SERVER_URL = 'https://kb.example.com/'
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('https://kb.example.com')
    if (prev) process.env.KB_SERVER_URL = prev
    else delete process.env.KB_SERVER_URL
  })
})

describe('KbApiClient', () => {
  it('[TC-3] health() calls /healthz', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, base: 'demo' }), { status: 200 }),
    )
    const client = new KbApiClient({
      connection: { url: 'http://127.0.0.1:9' },
      fetchImpl,
    })
    const health = await client.health()
    expect(health.base).toBe('demo')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9/healthz',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('[TC-4] connection errors include setup hints', () => {
    const msg = formatConnectionError({ url: 'http://localhost:38117' })
    expect(msg).toContain('kb-server start')
    expect(msg).toContain('kb config set server.host')
    expect(msg).toContain('KB_SERVER_URL')
    expect(msg).not.toContain('pnpm run server:up')
    expect(msg).not.toContain('kb-server install')
    expect(msg).toContain('Is the kb server running?')
  })
})
