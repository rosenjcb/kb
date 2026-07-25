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
  it('[TC-526][TC-242] buildKbRemoteEnv sets KB_SERVER_URL, KB_BASE, and clears host/port', () => {
    const prevNodePath = process.env.NODE_PATH
    process.env.NODE_PATH = '/tmp/node_path'
    try {
      const env = buildKbRemoteEnv({
        url: 'http://127.0.0.1:4242',
        apiKey: 'test-key',
        base: 'eval-raylib',
      })
      expect(env.KB_SERVER_URL).toBe('http://127.0.0.1:4242')
      expect(env.KB_SERVER_API_KEY).toBe('test-key')
      expect(env.KB_BASE).toBe('eval-raylib')
      expect(env.NODE_PATH).toBeUndefined()
      expect(env.KB_HOST).toBeUndefined()
      expect(env.KB_PORT).toBeUndefined()
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

  it('[TC-531] buildEvalOfflineEnv clears remote vars and does not set KB_LOCAL_MODE', () => {
    const prevLocal = process.env.KB_LOCAL_MODE
    const prevUrl = process.env.KB_SERVER_URL
    const prevHost = process.env.KB_HOST
    const prevPort = process.env.KB_PORT
    const prevKey = process.env.KB_SERVER_API_KEY
    delete process.env.KB_LOCAL_MODE
    process.env.KB_SERVER_URL = 'http://127.0.0.1:9999'
    process.env.KB_HOST = '127.0.0.1'
    process.env.KB_PORT = '9999'
    process.env.KB_SERVER_API_KEY = 'stale-key'
    try {
      const env = buildEvalOfflineEnv()
      // Must not inject KB_LOCAL_MODE; indexing uses eval-index.ts → @kb/core.
      expect(env.KB_LOCAL_MODE).toBeUndefined()
      expect(env.KB_SERVER_URL).toBeUndefined()
      expect(env.KB_HOST).toBeUndefined()
      expect(env.KB_PORT).toBeUndefined()
      expect(env.KB_SERVER_API_KEY).toBeUndefined()
    } finally {
      if (prevLocal === undefined) delete process.env.KB_LOCAL_MODE
      else process.env.KB_LOCAL_MODE = prevLocal
      if (prevUrl === undefined) delete process.env.KB_SERVER_URL
      else process.env.KB_SERVER_URL = prevUrl
      if (prevHost === undefined) delete process.env.KB_HOST
      else process.env.KB_HOST = prevHost
      if (prevPort === undefined) delete process.env.KB_PORT
      else process.env.KB_PORT = prevPort
      if (prevKey === undefined) delete process.env.KB_SERVER_API_KEY
      else process.env.KB_SERVER_API_KEY = prevKey
    }
  })

  it('[TC-529] DEFAULT_KB_SERVER_PORT is 38117', () => {
    expect(DEFAULT_KB_SERVER_PORT).toBe(38117)
  })

  it('[TC-530] buildKbRemoteEnv derives URL from host and default port', () => {
    const env = buildKbRemoteEnv({ host: '127.0.0.1', port: DEFAULT_KB_SERVER_PORT, apiKey: defaultEvalApiKey() })
    expect(env.KB_SERVER_URL).toBe('http://127.0.0.1:38117')
  })

  it('[TC-528] allocateFreePort returns a positive integer', async () => {
    const port = await allocateFreePort('127.0.0.1')
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('[TC-535] allocateFreePort yields distinct ports for concurrent callers', async () => {
    const ports = await Promise.all([
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
      allocateFreePort('127.0.0.1'),
    ])
    expect(new Set(ports).size).toBe(ports.length)
  })
})
