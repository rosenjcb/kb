import { describe, expect, it } from 'vitest'
import {
  assertSingleSentenceForSubmit,
  segmentMarkdownForFacts,
} from '../../src/core/sentence-split'

describe('segmentMarkdownForFacts', () => {
  it('treats ATX heading line as one segment (title only)', () => {
    expect(segmentMarkdownForFacts('## Hello World')).toEqual(['Hello World'])
  })

  it('preserves fenced code blocks as collapsed segments before prose', () => {
    const md = 'Intro here.\n```ts\nconst x = 1;\nconst y = 2;\n```\nSecond sentence follows.'
    const segs = segmentMarkdownForFacts(md)
    expect(segs.some(s => s.includes('const x = 1; const y = 2;'))).toBe(true)
    expect(segs).toContain('Intro here.')
    expect(segs).toContain('Second sentence follows.')
  })

  it('splits multiple sentences on one line', () => {
    const segs = segmentMarkdownForFacts('First fact here. Second fact here! Third stays?')
    expect(segs.length).toBeGreaterThanOrEqual(2)
  })

  it('drops segments shorter than 8 chars after normalize', () => {
    expect(segmentMarkdownForFacts('Hi. Ok.')).toEqual([])
  })
})

describe('assertSingleSentenceForSubmit', () => {
  it('returns trimmed single sentence', () => {
    expect(assertSingleSentenceForSubmit('  One clear sentence.  ')).toBe('One clear sentence.')
  })

  it('throws when multiple sentences detected', () => {
    expect(() => assertSingleSentenceForSubmit('First sentence. Second sentence.')).toThrow(
      /exactly one sentence/
    )
  })

  it('throws on empty', () => {
    expect(() => assertSingleSentenceForSubmit('   ')).toThrow(/empty/)
  })

  it('when no segment passes length filter but text is long enough, returns full trimmed text', () => {
    expect(assertSingleSentenceForSubmit('abcdefgh')).toBe('abcdefgh')
  })

  it('throws when text too short for fallback path', () => {
    expect(() => assertSingleSentenceForSubmit('short')).toThrow(/too short/)
  })
})
