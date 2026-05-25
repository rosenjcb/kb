import { describe, expect, it } from 'vitest'
import {
  formatFactContentForLLM,
  formatRetrievedFactsForLLM,
  formatToolQueryFactsForLLM,
} from '../../src/core/retrieval-context'

describe('retrieval-context', () => {
  it('Given long fact text, then LLM formatting keeps full content', () => {
    const long = 'x'.repeat(2500)
    expect(formatFactContentForLLM(long)).toBe(long)
    const formatted = formatRetrievedFactsForLLM([
      { metadata: { id: 'fact-a', title: 'Alpha' }, content: long },
    ])
    expect(formatted).toContain(long)
    expect(formatted).not.toContain('...')
  })

  it('Given multiple ranked facts, then all are included for LLM context', () => {
    const formatted = formatRetrievedFactsForLLM([
      { metadata: { id: 'fact-1' }, content: 'First fact body.' },
      { metadata: { id: 'fact-2' }, content: 'Second fact body.' },
      { metadata: { id: 'fact-3' }, content: 'Third fact body.' },
    ])
    expect(formatted).toContain('fact-1')
    expect(formatted).toContain('fact-2')
    expect(formatted).toContain('fact-3')
    expect(formatted).toContain('First fact body.')
    expect(formatted).toContain('Third fact body.')
  })

  it('Given tool query results, then tool payload uses full fact text for every row', () => {
    const body = 'Rust | .rs | yes | yes |'
    const formatted = formatToolQueryFactsForLLM([
      { metadata: { id: 'fact-rust' }, content: body },
      { metadata: { id: 'fact-go' }, content: 'Go | .go | yes | yes |' },
    ])
    expect(formatted).toContain('[fact-rust]')
    expect(formatted).toContain(body)
    expect(formatted).toContain('[fact-go]')
  })
})
