import { describe, expect, it, vi } from 'vitest'
import { KbApiClient } from '@kb/client/api/kb-api-client.js'
import { formatApiError, formatConnectionError } from '@kb/client/api/connection-error.js'
import {
  resolveActiveBaseName,
  resolveServerConnection,
  resolveServerConnectionWithBase,
  formatConnectionContext,
} from '@kb/client/api/server-connection.js'

describe('server-connection', () => {
  it('[TC-THW7] resolves KB_HOST/KB_PORT defaults to localhost:38117', () => {
    const prevHost = process.env.KB_HOST
    const prevPort = process.env.KB_PORT
    delete process.env.KB_HOST
    delete process.env.KB_PORT
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('http://localhost:38117')
    if (prevHost) process.env.KB_HOST = prevHost
    if (prevPort) process.env.KB_PORT = prevPort
  })

  it('[TC-V25H] bare remote hostname infers https under default sslmode (parity with kb://)', () => {
    const prevHost = process.env.KB_HOST
    const prevSslmode = process.env.KB_SSLMODE
    delete process.env.KB_SSLMODE
    process.env.KB_HOST = 'kb.example.com'
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('https://kb.example.com')
    if (prevHost === undefined) delete process.env.KB_HOST
    else process.env.KB_HOST = prevHost
    if (prevSslmode === undefined) delete process.env.KB_SSLMODE
    else process.env.KB_SSLMODE = prevSslmode
  })

  it('[TC-P35U] KB_SSLMODE=disable forces plaintext even for a remote host', () => {
    const prevHost = process.env.KB_HOST
    const prevSslmode = process.env.KB_SSLMODE
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_SSLMODE = 'disable'
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('http://kb.example.com:38117')
    if (prevHost === undefined) delete process.env.KB_HOST
    else process.env.KB_HOST = prevHost
    if (prevSslmode === undefined) delete process.env.KB_SSLMODE
    else process.env.KB_SSLMODE = prevSslmode
  })

  it('[TC-O9YH] KB_PORT is honored as an explicit port alongside an inferred scheme', () => {
    const prevHost = process.env.KB_HOST
    const prevPort = process.env.KB_PORT
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_PORT = '9443'
    const conn = resolveServerConnection({})
    expect(conn.url).toBe('https://kb.example.com:9443')
    if (prevHost === undefined) delete process.env.KB_HOST
    else process.env.KB_HOST = prevHost
    if (prevPort === undefined) delete process.env.KB_PORT
    else process.env.KB_PORT = prevPort
  })

  it('[TC-PYBW] formatConnectionContext shows host and base', () => {
    const line = formatConnectionContext({}, 'dogfood')
    expect(line).toContain('host: localhost:38117')
    expect(line).toContain('base: dogfood')
  })

  it('[TC-JD2O] formatConnectionContext labels the server-default base', () => {
    expect(formatConnectionContext({}, 'base', { serverDefault: true })).toContain(
      'base: base (server default)'
    )
    // A locally selected active base is shown without the label.
    expect(formatConnectionContext({}, 'dogfood', { serverDefault: false })).toContain(
      'base: dogfood'
    )
    expect(formatConnectionContext({}, 'dogfood')).not.toContain('server default')
  })

  it('[TC-7VJJ] resolveActiveBaseName returns KB_BASE (explicit --base / connection-string) first', async () => {
    const prevBase = process.env.KB_BASE
    process.env.KB_BASE = 'raylib'
    // The endpoint resolver no longer carries a base — base is resolved separately.
    expect(resolveServerConnection({}).base).toBeUndefined()
    expect(await resolveActiveBaseName({})).toBe('raylib')
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
  })

  it('[TC-P6JO] resolveServerConnectionWithBase sends the same base the UI shows (no drift)', async () => {
    const prevBase = process.env.KB_BASE
    process.env.KB_BASE = 'shared-base'
    const conn = await resolveServerConnectionWithBase({})
    // The wire base equals the unified resolver used by the status bar / banner.
    expect(conn.base).toBe(await resolveActiveBaseName({}))
    expect(conn.base).toBe('shared-base')
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
  })
})

describe('KbApiClient', () => {
  it('[TC-JJBZ] health() calls /health (passes through Cloud Run edge)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, base: 'demo' }), { status: 200 }),
    )
    const client = new KbApiClient({
      connection: { url: 'http://127.0.0.1:9' },
      fetchImpl,
    })
    const health = await client.health()
    expect(health.base).toBe('demo')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9/health',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('[TC-3GYT] health() falls back to /healthz when /health 404s (older servers)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.endsWith('/health')) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ ok: true, base: 'legacy' }), { status: 200 })
    })
    const client = new KbApiClient({
      connection: { url: 'http://127.0.0.1:9' },
      fetchImpl,
    })
    const health = await client.health()
    expect(health.base).toBe('legacy')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9/health',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9/healthz',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('[TC-N0AI] sends X-KB-Base when the connection carries a base', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, base: 'raylib' }), { status: 200 }))
    const client = new KbApiClient({
      connection: { url: 'http://127.0.0.1:9', base: 'raylib' },
      fetchImpl,
    })
    await client.health()
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get('X-KB-Base')).toBe('raylib')
  })

  it('[TC-GNQK] connection errors include setup hints', () => {
    const msg = formatConnectionError({ url: 'http://localhost:38117' })
    expect(msg).toContain('kb-server start')
    expect(msg).toContain('KB_HOST')
    expect(msg).toContain('KB_CONNECTION_STRING')
    expect(msg).toContain('--host')
    expect(msg).not.toContain('pnpm run server:up')
    expect(msg).not.toContain('kb-server install')
    expect(msg).toContain('Is the kb server running?')
  })
})

describe('formatApiError', () => {
  it('[TC-KRYS] turns a 401 into an actionable KB_SERVER_API_KEY hint', () => {
    const msg = formatApiError(401, JSON.stringify({ error: 'unauthorized' }))
    expect(msg).toContain('requires an API key')
    expect(msg).toContain('KB_SERVER_API_KEY')
    // The bare server payload alone must never be what the user sees.
    expect(msg).not.toBe('unauthorized')
  })

  it('[TC-2QL3] gives the API-key hint even when the 401 body is not JSON', () => {
    const msg = formatApiError(401, 'Unauthorized')
    expect(msg).toContain('KB_SERVER_API_KEY')
  })

  it('[TC-GTHU] passes through other server error messages unchanged', () => {
    expect(formatApiError(404, JSON.stringify({ error: 'base not found' }))).toBe('base not found')
  })

  it('[TC-XJ1F] falls back to a status code when the body has no error field', () => {
    expect(formatApiError(500, 'boom')).toBe('server error (500)')
  })
})
