import { describe, expect, it } from 'vitest'
import {
  allocateFreePort,
  buildKbRemoteEnv,
  defaultEvalApiKey,
} from '../scripts/eval-server.mjs'

describe('eval-server helpers', () => {
  it('[TC-526] buildKbRemoteEnv sets KB_SERVER_URL and drops KB_LOCAL_MODE', () => {
    const prevLocal = process.env.KB_LOCAL_MODE
    const prevNodePath = process.env.NODE_PATH
    process.env.KB_LOCAL_MODE = 'true'
    process.env.NODE_PATH = '/tmp/node_path'
    try {
      const env = buildKbRemoteEnv({ url: 'http://127.0.0.1:4242', apiKey: 'test-key' })
      expect(env.KB_SERVER_URL).toBe('http://127.0.0.1:4242')
      expect(env.KB_SERVER_API_KEY).toBe('test-key')
      expect(env.KB_LOCAL_MODE).toBeUndefined()
      expect(env.NODE_PATH).toBeUndefined()
      expect(env.KBHOST).toBeUndefined()
      expect(env.KBPORT).toBeUndefined()
    } finally {
      if (prevLocal === undefined) delete process.env.KB_LOCAL_MODE
      else process.env.KB_LOCAL_MODE = prevLocal
      if (prevNodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = prevNodePath
    }
  })

  it('[TC-527] buildKbRemoteEnv derives URL from host and port', () => {
    const env = buildKbRemoteEnv({ host: '127.0.0.1', port: 9090, apiKey: defaultEvalApiKey() })
    expect(env.KB_SERVER_URL).toBe('http://127.0.0.1:9090')
  })

  it('[TC-528] allocateFreePort returns a positive integer', async () => {
    const port = await allocateFreePort('127.0.0.1')
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })
})
