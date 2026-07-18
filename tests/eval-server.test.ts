import { describe, expect, it } from 'vitest'
import {
  allocateFreePort,
  buildKbLocalEnv,
  buildKbRemoteEnv,
  defaultEvalApiKey,
  healthzUrl,
  DEFAULT_KB_SERVER_PORT,
} from '../scripts/eval-server.mjs'

describe('eval-server helpers', () => {
  it('[TC-526] buildKbRemoteEnv sets KB_SERVER_URL and drops KB_LOCAL_MODE', () => {
    const prevLocal = process.env.KB_LOCAL_MODE
    const prevNodePath = process.env.NODE_PATH
    process.env.KB_LOCAL_MODE = 'true'
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
      expect(env.KB_LOCAL_MODE).toBeUndefined()
      expect(env.NODE_PATH).toBeUndefined()
      expect(env.KB_HOST).toBeUndefined()
      expect(env.KB_PORT).toBeUndefined()
    } finally {
      if (prevLocal === undefined) delete process.env.KB_LOCAL_MODE
      else process.env.KB_LOCAL_MODE = prevLocal
      if (prevNodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = prevNodePath
    }
  })

  it('healthzUrl appends ?base= for multi-base probes', () => {
    expect(healthzUrl('http://127.0.0.1:38117/', 'eval-kb')).toBe(
      'http://127.0.0.1:38117/healthz?base=eval-kb'
    )
    expect(healthzUrl('http://127.0.0.1:38117', undefined)).toBe(
      'http://127.0.0.1:38117/healthz'
    )
  })

  it('[TC-531] buildKbLocalEnv sets KB_LOCAL_MODE and clears remote vars', () => {
    const env = buildKbLocalEnv()
    expect(env.KB_LOCAL_MODE).toBe('true')
    expect(env.KB_SERVER_URL).toBeUndefined()
    expect(env.KB_SERVER_API_KEY).toBeUndefined()
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
