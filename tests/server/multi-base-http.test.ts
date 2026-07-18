import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { IntentResult } from '@kb/core/intents/types.js'
import type { KbService } from '@kb/core/service/kb-service.js'
import { createHttpServer } from '@kb/server/http-server.js'
import { BaseNotFoundError, type KbServiceRegistry } from '@kb/server/service-registry.js'

function makeStubService(base: string): KbService {
  return {
    baseDir: `/tmp/${base}`,
    toolExecutor: {} as KbService['toolExecutor'],
    llmProvider: undefined,
    query: async (params): Promise<IntentResult> => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: {
        answer: `[${base}] ${params.query}`,
        results: [],
        retrieval: { method: 'hybrid', detail: 'deep' },
      },
    }),
    chat: async function* () {
      yield { type: 'answer', text: `chat ${base}`, sources: [], factsRetrieved: 0 }
      yield { type: 'done' }
    },
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'ok',
    isReindexing: () => false,
    waitForBootstrap: async () => {},
    health: () => ({ ok: true, base }),
    close: async () => {},
  }
}

/** In-memory registry mirroring the shape of the real one. */
function makeRegistry(services: Record<string, KbService>, defaultName: string): KbServiceRegistry {
  return {
    defaultBaseName: defaultName,
    resolve(slug) {
      const key = slug?.trim()
      if (!key) return services[defaultName]
      const svc = services[key]
      if (!svc) throw new BaseNotFoundError(key)
      return svc
    },
    async list() {
      return Object.keys(services).map(name => ({
        name,
        path: `/tmp/${name}`,
        default: name === defaultName,
      }))
    },
    async closeAll() {},
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

describe('multi-base HTTP routing', () => {
  const services = { raylib: makeStubService('raylib'), eval: makeStubService('eval') }
  const registry = makeRegistry(services, 'raylib')

  it('[TC-82] routes /v1/query to the base named by X-KB-Base', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kb-base': 'eval' },
      body: JSON.stringify({ q: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).answer).toBe('[eval] hi')
  })

  it('[TC-83] falls back to the default base when no header is sent', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hi' }),
    })
    expect((await res.json()).answer).toBe('[raylib] hi')
  })

  it('[TC-84] returns 404 with unknown_base for a base with no index', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kb-base': 'nope' },
      body: JSON.stringify({ q: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ status: 'unknown_base' })
  })

  it('[TC-85] honors a body base override on /v1/query', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hi', base: 'eval' }),
    })
    expect((await res.json()).answer).toBe('[eval] hi')
  })

  it('[TC-86] /healthz?base= reports the named base', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/healthz?base=eval`)
    expect(res.status).toBe(200)
    expect((await res.json()).base).toBe('eval')
  })

  it('[TC-87] GET /v1/bases lists every served base', async () => {
    server = createHttpServer({ service: services.raylib, registry, apiKeys: [] })
    const base = await listen(server)
    const res = await fetch(`${base}/v1/bases`)
    const body = await res.json()
    expect(body.default).toBe('raylib')
    expect(body.bases.map((b: { name: string }) => b.name).sort()).toEqual(['eval', 'raylib'])
  })
})
