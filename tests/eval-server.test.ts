import { describe, expect, it } from 'vitest'
import {
  allocateFreePort,
  buildEvalOfflineEnv,
  buildKbRemoteEnv,
  defaultEvalApiKey,
  healthzUrl,
  DEFAULT_KB_SERVER_PORT,
} from '../scripts/eval-server.mjs'

describe('eval-server helpers', () => {
  it('[TC-249][TC-242] buildKbRemoteEnv decomposes a url into KB_HOST/KB_PORT/KB_SSLMODE, sets KB_BASE', () => {
    const prevNodePath = process.env.NODE_PATH
    process.env.NODE_PATH = '/tmp/node_path'
    try {
      const env = buildKbRemoteEnv({
        url: 'http://127.0.0.1:4242',
        apiKey: 'test-key',
        base: 'eval-raylib',
      })
      expect(env.KB_HOST).toBe('127.0.0.1')
      expect(env.KB_PORT).toBe('4242')
      expect(env.KB_SSLMODE).toBe('disable')
      expect(env.KB_SERVER_API_KEY).toBe('test-key')
      expect(env.KB_BASE).toBe('eval-raylib')
      expect(env.NODE_PATH).toBeUndefined()
    } finally {
      if (prevNodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = prevNodePath
    }
  })

  it('[TC-241] healthzUrl appends ?base= for multi-base probes', () => {
    expect(healthzUrl('http://127.0.0.1:38117/', 'eval-kb')).toBe(
      'http://127.0.0.1:38117/healthz?base=eval-kb'
    )
    expect(healthzUrl('http://127.0.0.1:38117', undefined)).toBe(
      'http://127.0.0.1:38117/healthz'
    )
  })

  it('[TC-253] buildEvalOfflineEnv clears remote connection vars', () => {
    const prevHost = process.env.KB_HOST
    const prevPort = process.env.KB_PORT
    const prevSslmode = process.env.KB_SSLMODE
    const prevConnectionString = process.env.KB_CONNECTION_STRING
    const prevKey = process.env.KB_SERVER_API_KEY
    process.env.KB_HOST = '127.0.0.1'
    process.env.KB_PORT = '9999'
    process.env.KB_SSLMODE = 'disable'
    process.env.KB_CONNECTION_STRING = 'kb://127.0.0.1:9999'
    process.env.KB_SERVER_API_KEY = 'stale-key'
    try {
      const env = buildEvalOfflineEnv()
      expect(env.KB_HOST).toBeUndefined()
      expect(env.KB_PORT).toBeUndefined()
      expect(env.KB_SSLMODE).toBeUndefined()
      expect(env.KB_CONNECTION_STRING).toBeUndefined()
      expect(env.KB_SERVER_API_KEY).toBeUndefined()
    } finally {
      if (prevHost === undefined) delete process.env.KB_HOST
      else process.env.KB_HOST = prevHost
      if (prevPort === undefined) delete process.env.KB_PORT
      else process.env.KB_PORT = prevPort
      if (prevSslmode === undefined) delete process.env.KB_SSLMODE
      else process.env.KB_SSLMODE = prevSslmode
      if (prevConnectionString === undefined) delete process.env.KB_CONNECTION_STRING
      else process.env.KB_CONNECTION_STRING = prevConnectionString
      if (prevKey === undefined) delete process.env.KB_SERVER_API_KEY
      else process.env.KB_SERVER_API_KEY = prevKey
    }
  })

  it('[TC-251] DEFAULT_KB_SERVER_PORT is 38117', () => {
    expect(DEFAULT_KB_SERVER_PORT).toBe(38117)
  })

  it('[TC-252] buildKbRemoteEnv passes through host and default port', () => {
    const env = buildKbRemoteEnv({ host: '127.0.0.1', port: DEFAULT_KB_SERVER_PORT, apiKey: defaultEvalApiKey() })
    expect(env.KB_HOST).toBe('127.0.0.1')
    expect(env.KB_PORT).toBe('38117')
  })

  it('[TC-250] allocateFreePort returns a positive integer', async () => {
    const port = await allocateFreePort('127.0.0.1')
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('[TC-254] allocateFreePort yields distinct ports for concurrent callers', async () => {
    const ports = await Promise.all([
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
    ])
    expect(new Set(ports).size).toBe(ports.length)
  })
})
