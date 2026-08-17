import { afterEach, describe, expect, it } from 'vitest'
import {
  formatChatTranscriptForDocSession,
  lastRetrievalCheckpointEvidence,
  shouldRefuseChatTurnOnRetrieval,
} from '@kb/client/cli/chat-cli.js'
import type { Message } from '@kb/core/core/types.js'

describe('chat retrieval refusal', () => {
  const prev = process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE
  afterEach(() => {
    if (prev === undefined) delete process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE
    else process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE = prev
  })

  it('[TC-XMSJ] refuses when no results', () => {
    expect(shouldRefuseChatTurnOnRetrieval({ results: [] })).toBe(true)
  })

  it('[TC-7HZP] allows when retrieval detail is all-facts:already-in-context even with zero results', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [],
        retrieval: { detail: 'all-facts:already-in-context' },
      })
    ).toBe(false)
  })

  it('[TC-DICS] refuses when last checkpoint below default min', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ evidence: 'none' }, { evidence: 'weak' }] },
      })
    ).toBe(true)
    // The *last* checkpoint decides, not the best one.
    expect(
      lastRetrievalCheckpointEvidence({
        retrieval: { checkpoints: [{ evidence: 'strong' }, { evidence: 'weak' }] },
      })
    ).toBe('weak')
  })

  it('[TC-HAF4] allows when checkpoints missing (no signal)', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { method: 'hybrid' },
      })
    ).toBe(false)
  })

  it('[TC-FRW1] allows when last checkpoint at or above min', () => {
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ evidence: 'moderate' }] },
      })
    ).toBe(false)
  })

  it('[TC-BN67] respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE', () => {
    process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE = 'strong'
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ evidence: 'moderate' }] },
      })
    ).toBe(true)
  })

  it('[TC-BN67] falls back to the default floor when the env label is unparseable', () => {
    process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE = '0.9'
    // A leftover numeric value must not silently disable the gate.
    expect(
      shouldRefuseChatTurnOnRetrieval({
        results: [{ metadata: { id: 'a' }, content: 'x' }],
        retrieval: { checkpoints: [{ evidence: 'weak' }] },
      })
    ).toBe(true)
  })
})

describe('formatChatTranscriptForDocSession', () => {
  it('[TC-S9Y9] formats user/assistant pairs and tail-truncates', () => {
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
