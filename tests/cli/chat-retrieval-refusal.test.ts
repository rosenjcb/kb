import { afterEach, describe, expect, it } from 'vitest'
import {
  formatChatTranscriptForDocSession,
  lastRetrievalCheckpointConfidence,
  shouldRefuseChatTurnOnRetrieval,
} from '@kb/client/cli/chat-cli.js'
import type { Message } from '@kb/core/core/types.js'

describe('chat retrieval refusal', () => {
  const prev = process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE
  afterEach(() => {
    if (prev === undefined) delete process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE
    else process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE = prev
  })

  it('[TC-107] refuses when no results', () => {
    expect(shouldRefuseChatTurnOnRetrieval({ results: [] })).toBe(true)
  })

  it('[TC-108] allows when retrieval detail is all-facts:already-in-context even with zero results', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [],
        retrieval: { detail: 'all-facts:already-in-context' },
      })
    ).toBe(false)
  })

  it('[TC-109] refuses when last checkpoint below default min', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ confidence: 0.2 }, { confidence: 0.3 }] },
      })
    ).toBe(true)
    expect(
      lastRetrievalCheckpointConfidence({
        retrieval: { checkpoints: [{ confidence: 1 }, { confidence: 0.3 }] },
      })
    ).toBe(0.3)
  })

  it('[TC-110] allows when checkpoints missing (no signal)', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { method: 'hybrid' },
      })
    ).toBe(false)
  })

  it('[TC-111] allows when last checkpoint at or above min', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ confidence: 0.45 }] },
      })
    ).toBe(false)
  })

  it('[TC-112] respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE', () => {
    process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE = '0.9'
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ confidence: 0.8 }] },
      })
    ).toBe(true)
  })
})

describe('formatChatTranscriptForDocSession', () => {
  it('[TC-113] formats user/assistant pairs and tail-truncates', () => {
    const long = 'x'.repeat(500)
    const messages: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: long },
      { role: 'user', content: 'new q' },
    ]
    const out = formatChatTranscriptForDocSession(messages, 120)
    expect(out).toContain('new q')
    expect(out).toContain('earlier chat truncated')
    expect(out.length).toBeLessThanOrEqual(120)
  })
})
