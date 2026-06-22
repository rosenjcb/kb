import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../../src/core/types'
import { buildMcpToolList, dispatchMcpToolCall } from '../../src/server/mcp-tools'
import type { KbService } from '../../src/server/kb-service'

const registryTools: ToolDefinition[] = [
  { name: 'read_facts', description: 'Search facts', schema: { type: 'object', properties: {} } },
  { name: 'search_code_symbols', description: 'Search symbols', schema: { type: 'object', properties: {} } },
  { name: 'upsert_fact', description: 'Write a fact', schema: { type: 'object', properties: {} } },
]

function makeStubService(overrides: Partial<KbService> = {}): KbService {
  const execute = vi.fn(async () => ({ results: ['fact-1'] }))
  return {
    baseDir: '/tmp/base',
    toolExecutor: {
      getTools: () => registryTools,
      execute,
      register: () => {},
    },
    llmProvider: undefined,
    query: async params => ({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: { answer: `synth:${params.synthesize}`, results: [], retrieval: {} },
    }),
    chat: async function* () {
      yield { type: 'done' }
    },
    readFacts: async () => ({ results: [] }),
    reindex: async () => 'ok',
    isReindexing: () => false,
    health: () => ({ ok: true, base: 'base' }),
    close: async () => {},
    ...overrides,
  }
}

describe('buildMcpToolList', () => {
  it('exposes kb_query plus the read-only allowlist, prefixed and never upsert_fact', () => {
    const tools = buildMcpToolList(makeStubService())
    const names = tools.map(t => t.name)
    expect(names).toContain('kb_query')
    expect(names).toContain('kb_read_facts')
    expect(names).toContain('kb_search_code_symbols')
    expect(names).not.toContain('kb_upsert_fact')
    // schemas carry through as JSON Schema objects.
    const readFacts = tools.find(t => t.name === 'kb_read_facts')
    expect(readFacts?.inputSchema).toMatchObject({ type: 'object' })
  })
})

describe('dispatchMcpToolCall', () => {
  it('runs kb_query without synthesis by default', async () => {
    const service = makeStubService()
    const result = await dispatchMcpToolCall(service, 'kb_query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('"status": "accepted"')
  })

  it('errors when kb_query is missing q', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', {})
    expect(result.isError).toBe(true)
  })

  it('delegates allowlisted registry tools to the executor', async () => {
    const execute = vi.fn(async () => ({ results: ['fact-1'] }))
    const service = makeStubService({
      toolExecutor: { getTools: () => registryTools, execute, register: () => {} },
    })
    const result = await dispatchMcpToolCall(service, 'kb_read_facts', { query: 'x' })
    expect(execute).toHaveBeenCalledWith({ id: 'mcp', name: 'read_facts', input: { query: 'x' } })
    expect(result.content[0].text).toContain('fact-1')
  })

  it('refuses tools outside the allowlist', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_upsert_fact', { factText: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unavailable')
  })
})
