import { describe, expect, it, vi } from 'vitest'
import { KbApiClient } from '@kb/client/api/kb-api-client.js'
import { formatApiError, formatConnectionError } from '@kb/client/api/connection-error.js'
import { resolveServerConnection, formatConnectionContext } from '@kb/client/api/server-connection.js'

describe('server-connection', () => {
  it('[TC-1] resolves KB_HOST/KB_PORT defaults to localhost:38117', () => {
    const prevHost = process.env.KB_HOST
    const prevPort = process.env.KB_PORT
    delete process.env.KB_HOST
    delete process.env.KB_PORT
    delete process.env.KB_SERVER_URL
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('http://localhost:38117')
    if (prevHost) process.env.KB_HOST = prevHost
    if (prevPort) process.env.KB_PORT = prevPort
  })

  it('[TC-2] prefers KB_SERVER_URL override', () => {
    const prev = process.env.KB_SERVER_URL
    process.env.KB_SERVER_URL = 'https://kb.example.com/'
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('https://kb.example.com')
    if (prev) process.env.KB_SERVER_URL = prev
    else delete process.env.KB_SERVER_URL
  })

  it('[TC-505] formatConnectionContext shows host and base in remote mode', () => {
    const prevLocal = process.env.KB_LOCAL_MODE
    delete process.env.KB_LOCAL_MODE
    delete process.env.KB_SERVER_URL
    const line = formatConnectionContext({}, 'dogfood')
    expect(line).toContain('host: localhost:38117')
    expect(line).toContain('base: dogfood')
    if (prevLocal) process.env.KB_LOCAL_MODE = prevLocal
  })

  it('[TC-506] formatConnectionContext shows local mode label', () => {
    const prevLocal = process.env.KB_LOCAL_MODE
    process.env.KB_LOCAL_MODE = 'true'
    const line = formatConnectionContext({}, 'eval-raylib')
    expect(line).toContain('mode: local')
    expect(line).toContain('base: eval-raylib')
    if (prevLocal) process.env.KB_LOCAL_MODE = prevLocal
    else delete process.env.KB_LOCAL_MODE
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
    expect(msg).toContain('KB_HOST')
    expect(msg).toContain('KB_SERVER_URL')
    expect(msg).toContain('--host')
    expect(msg).not.toContain('pnpm run server:up')
    expect(msg).not.toContain('kb-server install')
    expect(msg).toContain('Is the kb server running?')
  })
})

describe('formatApiError', () => {
  it('[TC-620] turns a 401 into an actionable KB_SERVER_API_KEY hint', () => {
    const msg = formatApiError(401, JSON.stringify({ error: 'unauthorized' }))
    expect(msg).toContain('requires an API key')
    expect(msg).toContain('KB_SERVER_API_KEY')
    // The bare server payload alone must never be what the user sees.
    expect(msg).not.toBe('unauthorized')
  })

  it('[TC-621] gives the API-key hint even when the 401 body is not JSON', () => {
    const msg = formatApiError(401, 'Unauthorized')
    expect(msg).toContain('KB_SERVER_API_KEY')
  })

  it('[TC-622] passes through other server error messages unchanged', () => {
    expect(formatApiError(404, JSON.stringify({ error: 'base not found' }))).toBe('base not found')
  })

  it('[TC-623] falls back to a status code when the body has no error field', () => {
    expect(formatApiError(500, 'boom')).toBe('server error (500)')
  })
})
