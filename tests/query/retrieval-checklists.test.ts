import { describe, expect, it, vi } from 'vitest'
import {
  classifyQueryDocType,
  formatRetrievalChecklist,
  retrievalChecklistPromptBlock,
} from '@kb/core/query/retrieval-checklists.js'
import { makeSufficiencyJudge } from '@kb/core/tools/facts-sufficiency-judge.js'
import { expandQuery } from '@kb/core/tools/query-expander.js'
import type { LLMProvider } from '@kb/core/core/types.js'

describe('classifyQueryDocType', () => {
  it('[TC-1] Given a howto / how to question, then classifies as howto', () => {
    expect(classifyQueryDocType('how do I initialize a KB base?')).toBe('howto')
    expect(classifyQueryDocType('how to set up the server')).toBe('howto')
  })

  it('[TC-2] Given an error / fix / runbook question, then classifies as runbook', () => {
    expect(classifyQueryDocType('how do I fix a failed kb-server restart?')).toBe('runbook')
    expect(classifyQueryDocType('troubleshoot outage on /healthz')).toBe('runbook')
  })

  it('[TC-3] Given a why / trade-off question, then classifies as decision', () => {
    expect(classifyQueryDocType('why did we choose SQLite for hybrid search?')).toBe('decision')
    expect(classifyQueryDocType('what are the trade-offs versus Redis?')).toBe('decision')
  })

  it('[TC-4] Given an API / CLI / flags question, then classifies as reference', () => {
    expect(classifyQueryDocType('what CLI flags does kb query support?')).toBe('reference')
    expect(classifyQueryDocType('document the kb sync API parameters')).toBe('reference')
  })

  it('[TC-5] Given an overview / what is this question, then classifies as introduction', () => {
    expect(classifyQueryDocType('give me a high-level overview of this project')).toBe(
      'introduction'
    )
    expect(classifyQueryDocType('what is this system mental model?')).toBe('introduction')
  })
})

describe('formatRetrievalChecklist', () => {
  it('[TC-6] Given howto, then includes goal/steps and omits documentTitle', () => {
    const text = formatRetrievalChecklist('howto')
    expect(text).toContain('- goal:')
    expect(text).toContain('- steps:')
    expect(text).not.toMatch(/documentTitle/)
  })
})

describe('retrievalChecklistPromptBlock', () => {
  it('includes Answer type and Coverage checklist headers', () => {
    const { docType, promptBlock } = retrievalChecklistPromptBlock('how to install kb')
    expect(docType).toBe('howto')
    expect(promptBlock).toContain('Answer type: howto')
    expect(promptBlock).toContain('Coverage checklist')
    expect(promptBlock).toContain('- goal:')
  })
})

const ENOUGH_FACTS = Array.from({ length: 6 }, (_, i) => ({
  id: `fact-${i}`,
  text: `fact content ${i}`,
}))

describe('sufficiency + expand checklist injection', () => {
  it('[TC-7] Given sufficiency judge LLM call, then prompt includes Answer type + Coverage checklist', async () => {
    const call = vi.fn(async () => ({
      text: 'ANSWERABLE',
      stopReason: 'end_turn' as const,
      toolUses: [],
      usage: { inputTokens: 10, outputTokens: 2 },
    }))
    const llm = {
      name: 'mock',
      model: 'mock',
      supportsStreaming: false,
      call,
    } as unknown as LLMProvider

    const judge = makeSufficiencyJudge(llm)
    await judge('how do I run kb init?', ENOUGH_FACTS)

    expect(call).toHaveBeenCalledTimes(1)
    const content = call.mock.calls[0][0].messages[0].content as string
    expect(content).toContain('Answer type: howto')
    expect(content).toContain('Coverage checklist')
    expect(content).toContain('- goal:')
  })

  it('[TC-8] Given expandQuery LLM call, then user content includes Coverage checklist', async () => {
    const call = vi.fn(async () => ({
      text: '["fzf purpose", "fzf features", "fzf usage"]',
      inputTokens: 0,
      outputTokens: 0,
    }))
    const llm = { call } as unknown as LLMProvider
    await expandQuery(llm, 'what is fzf?')

    expect(call).toHaveBeenCalledTimes(1)
    const content = call.mock.calls[0][0].messages[0].content as string
    expect(content).toContain('Coverage checklist')
    expect(content).toMatch(/Answer type:/)
  })
})
