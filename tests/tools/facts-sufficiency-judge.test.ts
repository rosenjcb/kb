import { describe, expect, it } from 'vitest'
import { makeSufficiencyJudge, shouldCallJudge } from '../../src/tools/facts-sufficiency-judge'
import type { LLMProvider } from '../../src/core/types'

function makeLLM(text: string): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    supportsStreaming: false,
    call: async () => ({ text, inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0 }),
  } as unknown as LLMProvider
}

const ENOUGH_FACTS = Array.from({ length: 6 }, (_, i) => ({
  id: `fact-${i}`,
  text: `fact content ${i}`,
}))

describe('makeSufficiencyJudge', () => {
  it('Given ANSWERABLE response, then returns answerable', async () => {
    const judge = makeSufficiencyJudge(makeLLM('ANSWERABLE'))
    expect(await judge('what is X', ENOUGH_FACTS)).toBe('answerable')
  })

  it('Given INSUFFICIENT response, then returns insufficient', async () => {
    const judge = makeSufficiencyJudge(makeLLM('INSUFFICIENT'))
    expect(await judge('what is X', ENOUGH_FACTS)).toBe('insufficient')
  })

  it('Given partial ANSWERABLE prefix in response, then still returns answerable', async () => {
    const judge = makeSufficiencyJudge(makeLLM('ANSWERABLE.'))
    expect(await judge('what is X', ENOUGH_FACTS)).toBe('answerable')
  })

  it('Given fewer facts than minimum threshold, then returns insufficient without calling LLM', async () => {
    let called = false
    const llm = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: async () => { called = true; return { text: 'ANSWERABLE', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } },
    } as unknown as LLMProvider

    const judge = makeSufficiencyJudge(llm)
    const result = await judge('what is X', [{ id: 'fact-1', text: 'only one fact' }])
    expect(result).toBe('insufficient')
    expect(called).toBe(false)
  })

  it('Given LLM throws, then returns insufficient as fallback', async () => {
    const llm = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call: async () => { throw new Error('network error') },
    } as unknown as LLMProvider

    const judge = makeSufficiencyJudge(llm)
    expect(await judge('what is X', ENOUGH_FACTS)).toBe('insufficient')
  })
})

describe('shouldCallJudge', () => {
  it('Returns true when iteration is a multiple of JUDGE_CALL_INTERVAL and enough relevant facts', () => {
    expect(shouldCallJudge(0, 5)).toBe(true)
    expect(shouldCallJudge(3, 5)).toBe(true)
    expect(shouldCallJudge(6, 10)).toBe(true)
  })

  it('Returns false when not on a call interval', () => {
    expect(shouldCallJudge(1, 5)).toBe(false)
    expect(shouldCallJudge(2, 5)).toBe(false)
    expect(shouldCallJudge(4, 5)).toBe(false)
  })

  it('Returns false when relevant facts below threshold regardless of interval', () => {
    expect(shouldCallJudge(0, 0)).toBe(false)
    expect(shouldCallJudge(3, 4)).toBe(false)
  })
})
