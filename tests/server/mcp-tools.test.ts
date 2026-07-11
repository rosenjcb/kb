import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@kb/core/core/types.js'
import { buildMcpToolList, dispatchMcpToolCall } from '@kb/server/mcp-tools.js'
import type { KbService } from '@kb/core/service/kb-service.js'

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
  it('[TC-21] exposes kb_query only, never exposes allowlist tools or upsert_fact', () => {
    const tools = buildMcpToolList(makeStubService())
    const names = tools.map(t => t.name)
    expect(names).toEqual(['kb_query'])
  })
})

describe('dispatchMcpToolCall', () => {
  it('[TC-22] always synthesizes an answer (answer-first, no synthesize flag)', async () => {
    const service = makeStubService()
    const result = await dispatchMcpToolCall(service, 'kb_query', { q: 'auth' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('"status": "accepted"')
    // The stub echoes params.synthesize into the answer; MCP must always pass true.
    expect(result.content[0].text).toContain('synth:true')
  })

  it('[TC-23] errors when kb_query is missing q', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_query', {})
    expect(result.isError).toBe(true)
  })

  it('[TC-24] refuses former registry tools like kb_read_facts', async () => {
    const execute = vi.fn(async () => ({ results: ['fact-1'] }))
    const service = makeStubService({
      toolExecutor: { getTools: () => registryTools, execute, register: () => {} },
    })
    const result = await dispatchMcpToolCall(service, 'kb_read_facts', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Unknown or unavailable tool')
    expect(execute).not.toHaveBeenCalled()
  })

  it('[TC-25] refuses tools outside the allowlist', async () => {
    const result = await dispatchMcpToolCall(makeStubService(), 'kb_upsert_fact', { factText: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unavailable')
  })
})
