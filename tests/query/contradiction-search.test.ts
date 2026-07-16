import { RunCollector, summarizeQueryRetrievalTrace } from '@kb/core/core/telemetry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import {
  confidenceFromSupportAndContradiction,
  runContradictionSearch,
} from '@kb/core/query/contradiction-search.js'
import type { ReadDocumentsResultData } from '@kb/core/query/intent-cli.js'
import { describe, expect, it, vi } from 'vitest'

function makeResult(answer: string, factIds: string[], confidence = 0.8): IntentResult {
  return {
    status: 'accepted',
    recommendedAction: 'read_facts',
    confidence,
    data: {
      answer,
      results: factIds.map(id => ({
        metadata: { id, title: `title ${id}`, filePath: `fact://${id}` },
        content: `content for ${id}`,
      })),
      total: factIds.length,
      retrieval: {
        method: 'hybrid',
        detail: 'facts-loop;passes:1;facts:1',
        checkpoints: [{ confidence }],
      },
    } satisfies ReadDocumentsResultData,
  }
}

function scriptedLlm(responses: string[]): LLMProvider {
  let i = 0
  return {
    name: 'test-provider',
    model: 'test-model',
    call: vi.fn(async () => {
      const text = responses[Math.min(i, responses.length - 1)] ?? '{}'
      i++
      return {
        text,
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 20, outputTokens: 10 },
      }
    }),
  } as unknown as LLMProvider
}

describe('confidenceFromSupportAndContradiction', () => {
  it('[TC-6] Given no contradictions, then returns base confidence unchanged', () => {
    expect(confidenceFromSupportAndContradiction(0.8, 10, 0)).toBe(0.8)
  })

  it('[TC-7] Given support and contradict counts, then scales base by support/(support+contradict)', () => {
    // 0.8 * 9/10 = 0.72
    expect(confidenceFromSupportAndContradiction(0.8, 9, 1)).toBeCloseTo(0.72, 5)
  })
})

describe('runContradictionSearch', () => {
  it('[TC-1] Given no draft answer, then skips with ran=false', async () => {
    const result = makeResult('', ['a'])
    ;(result.data as ReadDocumentsResultData).answer = undefined
    const out = await runContradictionSearch({
      question: 'q',
      result,
      llm: scriptedLlm([]),
      baseDir: '/tmp',
    })
    const data = out.data as ReadDocumentsResultData
    expect(data.retrieval?.contradiction).toMatchObject({ ran: false, found: false, used: false })
  })

  it('[TC-2] Given adversarial hits that do not contradict, then keeps the draft', async () => {
    const collector = new RunCollector('query')
    const llm = scriptedLlm([
      JSON.stringify({
        claims: [{ claim: 'Auth uses OAuth only', disproveQuery: 'auth without oauth' }],
      }),
      JSON.stringify({ contradict: [] }),
    ])
    const out = await runContradictionSearch({
      question: 'How does auth work?',
      result: makeResult('Auth uses OAuth only.', ['known-1'], 0.7),
      llm,
      baseDir: '/tmp',
      collector,
      searchFacts: () => [{ id: 'noise-1', fact_text: 'Logging uses structured JSON.' }],
    })
    const data = out.data as ReadDocumentsResultData
    expect(data.retrieval?.contradiction).toMatchObject({
      ran: true,
      found: false,
      used: false,
      hitCount: 0,
      contradictCount: 0,
      confidenceAfter: 0.7,
    })
    expect(out.confidence).toBe(0.7)
    expect(data.answer).toBe('Auth uses OAuth only.')
  })

  it('[TC-3] Given contradicting facts, then revises the answer and sets used=true', async () => {
    const collector = new RunCollector('query')
    const llm = scriptedLlm([
      JSON.stringify({
        claims: [{ claim: 'Deploy uses Helm only', disproveQuery: 'deploy without helm' }],
      }),
      JSON.stringify({ contradict: ['contra-1'] }),
      'Deploy prefers Helm but also supports raw manifests via kubectl.',
    ])
    const out = await runContradictionSearch({
      question: 'How do we deploy?',
      result: makeResult('Deploy uses Helm only.', ['known-1'], 0.8),
      llm,
      baseDir: '/tmp',
      collector,
      searchFacts: () => [
        {
          id: 'contra-1',
          fact_text: 'Production deploys also apply raw Kubernetes manifests with kubectl.',
        },
      ],
    })
    const data = out.data as ReadDocumentsResultData
    expect(data.answer).toContain('raw manifests')
    expect(data.retrieval?.contradiction).toMatchObject({
      ran: true,
      found: true,
      used: true,
      hitCount: 1,
      factIds: ['contra-1'],
      supportCount: 1,
      contradictCount: 1,
    })
    // 0.8 * 1/(1+1) = 0.4
    expect(out.confidence).toBeCloseTo(0.4, 5)
    expect(data.retrieval?.confidence).toBeCloseTo(0.4, 5)
    expect(data.results?.some(r => r.metadata?.id === 'contra-1')).toBe(true)
  })

  it('[TC-4] Given LLM failure, then keeps the draft with ran=true found=false', async () => {
    const llm: LLMProvider = {
      name: 'test',
      model: 'test',
      call: async () => {
        throw new Error('boom')
      },
    }
    const out = await runContradictionSearch({
      question: 'q',
      result: makeResult('Draft stays.', ['a'], 0.6),
      llm,
      baseDir: '/tmp',
    })
    const data = out.data as ReadDocumentsResultData
    expect(data.answer).toBe('Draft stays.')
    expect(data.retrieval?.contradiction).toMatchObject({ ran: true, found: false, used: false })
    expect(out.confidence).toBe(0.6)
  })
})

describe('summarizeQueryRetrievalTrace contradiction', () => {
  it('[TC-5] Given a contradiction audit, then lifts it onto the RunReport trace', () => {
    const trace = summarizeQueryRetrievalTrace({
      method: 'hybrid',
      detail: 'facts-loop;passes:1;facts:3',
      contradiction: {
        ran: true,
        found: true,
        used: true,
        hitCount: 2,
        queries: ['disprove claim'],
        factIds: ['c1', 'c2'],
        supportCount: 8,
        contradictCount: 2,
        confidenceBefore: 0.9,
        confidenceAfter: 0.72,
      },
    })
    expect(trace.contradiction).toEqual({
      ran: true,
      found: true,
      used: true,
      hitCount: 2,
      queries: ['disprove claim'],
      factIds: ['c1', 'c2'],
      supportCount: 8,
      contradictCount: 2,
      confidenceBefore: 0.9,
      confidenceAfter: 0.72,
    })
  })
})
