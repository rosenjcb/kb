import { describe, expect, it } from 'vitest'
import {
  formatFactContentForLLM,
  formatRetrievedFactsForLLM,
  formatToolQueryFactsForLLM,
  MAX_FACT_CONTENT_CHARS,
} from '@kb/core/core/retrieval-context.js'

describe('retrieval-context', () => {
  it('[TC-104] Given long fact text with no limit, then full content is kept', () => {
    const long = 'x'.repeat(2500)
    expect(formatFactContentForLLM(long)).toBe(long)
    const formatted = formatRetrievedFactsForLLM([
      { metadata: { id: 'fact-a', title: 'Alpha' }, content: long },
    ])
    expect(formatted).toContain(long)
  })

  it('[TC-105] Given maxContentChars set, then long fact content is truncated with ellipsis', () => {
    const long = 'a'.repeat(1000)
    const formatted = formatRetrievedFactsForLLM(
      [{ metadata: { id: 'fact-a' }, content: long }],
      { maxContentChars: 100 }
    )
    expect(formatted).toContain('a'.repeat(100))
    expect(formatted).toContain('…')
    expect(formatted).not.toContain('a'.repeat(101))
  })

  it('[TC-106] Given maxContentChars set, then short fact content is kept unchanged', () => {
    const short = 'short fact'
    const formatted = formatRetrievedFactsForLLM(
      [{ metadata: { id: 'fact-a' }, content: short }],
      { maxContentChars: 100 }
    )
    expect(formatted).toContain(short)
    expect(formatted).not.toContain('…')
  })

  it('[TC-107] Given multiple ranked facts, then all bodies are included for LLM context', () => {
    const formatted = formatRetrievedFactsForLLM([
      { metadata: { id: 'fact-1' }, content: 'First fact body.' },
      { metadata: { id: 'fact-2' }, content: 'Second fact body.' },
      { metadata: { id: 'fact-3' }, content: 'Third fact body.' },
    ])
    expect(formatted).toContain('First fact body.')
    expect(formatted).toContain('Second fact body.')
    expect(formatted).toContain('Third fact body.')
  })

  it('[TC-108] Given facts, then evidence is not framed as enumerated/citable items (no "Fact N", no id= leak)', () => {
    const formatted = formatRetrievedFactsForLLM([
      { metadata: { id: 'fact-a', title: 'Alpha' }, content: 'Body A.' },
      { metadata: { id: 'fact-b', title: 'Beta' }, content: 'Body B.' },
    ])
    expect(formatted).not.toMatch(/Fact \d/)
    expect(formatted).not.toContain('id=')
    expect(formatted).not.toContain('fact-a')
    // Natural-language titles are still allowed as plain lead-ins.
    expect(formatted).toContain('Alpha')
    expect(formatted).toContain('Body A.')
  })

  it('[TC-109] Given tool query results, then tool payload truncates long fact bodies by default', () => {
    const long = 'x'.repeat(2500)
    const formatted = formatToolQueryFactsForLLM([
      { metadata: { id: 'fact-rust' }, content: long },
    ])
    expect(formatted).toContain('[fact-rust]')
    expect(formatted).toContain('x'.repeat(MAX_FACT_CONTENT_CHARS))
    expect(formatted).toContain('…')
    expect(formatted).not.toContain('x'.repeat(2500))
  })
})
