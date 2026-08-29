import { describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import {
  parseUnsupportedClaims,
  shouldVerifyClaims,
  verifyAnswerClaims,
} from '@kb/core/query/claim-verification.js'

function fakeLlm(responseText: string): LLMProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    supportsStreaming: false,
    call: async () => ({
      text: responseText,
      stopReason: 'end_turn' as const,
      toolUses: [],
      usage: { inputTokens: 11, outputTokens: 7 },
    }),
  }
}

describe('parseUnsupportedClaims', () => {
  it('[TC-CV00] treats a lone NONE (any case/punctuation) as everything supported', () => {
    expect(parseUnsupportedClaims('NONE')).toEqual([])
    expect(parseUnsupportedClaims('  none.  ')).toEqual([])
    expect(parseUnsupportedClaims('None!')).toEqual([])
    expect(parseUnsupportedClaims('')).toEqual([])
  })

  it('[TC-CV01] parses bulleted and numbered claim lines, stripping markers', () => {
    const claims = parseUnsupportedClaims(
      ['- Import POSTs to the backend.', '2) It persists the flow immediately.'].join('\n')
    )
    expect(claims).toEqual(['Import POSTs to the backend.', 'It persists the flow immediately.'])
  })

  it('[TC-CV02] dedupes repeated claims and drops stray NONE lines', () => {
    const claims = parseUnsupportedClaims(
      ['- Import saves the flow.', 'NONE', '- import saves the flow.'].join('\n')
    )
    expect(claims).toEqual(['Import saves the flow.'])
  })

  it('[TC-CV03] caps the list so one runaway reply cannot flood the caller', () => {
    const many = Array.from({ length: 20 }, (_, i) => `- claim ${i}`).join('\n')
    expect(parseUnsupportedClaims(many).length).toBe(8)
  })
})

describe('shouldVerifyClaims', () => {
  it('[TC-CV04] is off by default (no env, no param)', () => {
    expect(shouldVerifyClaims({ evidence: 'strong', env: {} })).toBe(false)
  })

  it('[TC-CV05] the explicit param overrides the env default', () => {
    expect(shouldVerifyClaims({ verifyClaims: true, evidence: 'strong', env: {} })).toBe(true)
    expect(
      shouldVerifyClaims({ verifyClaims: false, evidence: 'strong', env: { KB_QUERY_VERIFY_CLAIMS: 'true' } })
    ).toBe(false)
  })

  it('[TC-CV06] KB_QUERY_VERIFY_CLAIMS=true enables it, but only above the confidence floor', () => {
    const env = { KB_QUERY_VERIFY_CLAIMS: 'true' }
    // Default floor is `strong`.
    expect(shouldVerifyClaims({ evidence: 'strong', env })).toBe(true)
    expect(shouldVerifyClaims({ evidence: 'moderate', env })).toBe(false)
    expect(shouldVerifyClaims({ evidence: 'weak', env })).toBe(false)
  })

  it('[TC-CV07] the floor is configurable via KB_QUERY_VERIFY_MIN_CONFIDENCE', () => {
    const env = { KB_QUERY_VERIFY_CLAIMS: 'true', KB_QUERY_VERIFY_MIN_CONFIDENCE: 'moderate' }
    expect(shouldVerifyClaims({ evidence: 'moderate', env })).toBe(true)
    expect(shouldVerifyClaims({ evidence: 'weak', env })).toBe(false)
  })

  it('[TC-CV08] runs when opted in with no evidence label to floor against', () => {
    expect(shouldVerifyClaims({ verifyClaims: true, env: {} })).toBe(true)
  })
})

describe('verifyAnswerClaims', () => {
  const results = [
    {
      metadata: { id: 'FlowCreate.vue', title: 'FlowCreate.vue' },
      content: 'handleImportSubmit calls initialize(undefined, undefined, yaml) which sets flowYaml locally.',
    },
  ]

  it('[TC-CV09] returns the flagged claims and echoes token usage', async () => {
    const llm = fakeLlm('- The answer says import POSTs to the backend, but the source only sets local state.')
    const outcome = await verifyAnswerClaims({
      question: 'What does import do?',
      answer: 'Import POSTs the flow to the backend and persists it.',
      results,
      llmProvider: llm,
    })
    expect(outcome.unsupportedClaims).toHaveLength(1)
    expect(outcome.unsupportedClaims[0]).toContain('POSTs to the backend')
    expect(outcome.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
  })

  it('[TC-CV10] returns an empty list when the verifier answers NONE', async () => {
    const outcome = await verifyAnswerClaims({
      question: 'What does import do?',
      answer: 'Import sets the YAML into local editor state; no backend call happens.',
      results,
      llmProvider: fakeLlm('NONE'),
    })
    expect(outcome.unsupportedClaims).toEqual([])
  })

  it('[TC-CV11] sends the answer and evidence to the provider in one no-tools call', async () => {
    const call = vi.fn(async () => ({
      text: 'NONE',
      stopReason: 'end_turn' as const,
      toolUses: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }))
    const llm: LLMProvider = { name: 'fake', model: 'm', supportsStreaming: false, call }
    await verifyAnswerClaims({
      question: 'Q',
      answer: 'Import POSTs to the backend.',
      results,
      llmProvider: llm,
    })
    expect(call).toHaveBeenCalledTimes(1)
    const params = call.mock.calls[0][0]
    expect(params.tools).toBeUndefined()
    const userContent = params.messages[0].content as string
    expect(userContent).toContain('Import POSTs to the backend.')
    expect(userContent).toContain('handleImportSubmit')
  })
})
