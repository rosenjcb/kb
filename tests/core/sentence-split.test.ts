import { describe, expect, it } from 'vitest'
import {
  assertSingleSentenceFact,
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

  it('can merge short adjacent prose into coarser scan chunks', () => {
    const md = [
      '# Scan',
      '',
      'First short sentence about scan facts.',
      'Second short sentence about graph rebuild.',
      'Third sentence closes the paragraph with enough detail to survive.',
    ].join('\n')
    expect(
      segmentMarkdownForFacts(md, {
        minSegmentLength: 50,
        mergeShortSegmentsBelow: 100,
      })
    ).toEqual([
      'Scan First short sentence about scan facts. Second short sentence about graph rebuild. Third sentence closes the paragraph with enough detail to survive.',
    ])
  })

  it('strips the OKF frontmatter block and segments only the body (no boosting facts)', () => {
    const md = [
      '---',
      'type: Subsystem',
      'title: Query Engine',
      'description: Runs the plateau-based retrieval orchestrator.',
      'tags: [retrieval, query]',
      '---',
      '',
      '# Query Engine',
      '',
      'It exhausts the repo fact pool before walking cross-repo edges.',
    ].join('\n')
    const segs = segmentMarkdownForFacts(md)
    // Body content is indexed exactly like plain markdown.
    expect(segs).toContain('Query Engine')
    expect(segs).toContain('It exhausts the repo fact pool before walking cross-repo edges.')
    // No synthesized identity/tag/description "boosting" facts.
    expect(segs).not.toContain('Query Engine is a Subsystem.')
    expect(segs.some(s => s.includes('relates to'))).toBe(false)
    // The raw YAML keys never become facts either.
    expect(segs.some(s => s.includes('type:') || s.includes('tags:'))).toBe(false)
    // The frontmatter `description` (metadata, not body) is not indexed.
    expect(segs).not.toContain('Runs the plateau-based retrieval orchestrator.')
  })

  it('leaves plain markdown (no frontmatter) segmentation unchanged', () => {
    expect(segmentMarkdownForFacts('## Hello World')).toEqual(['Hello World'])
  })
})

describe('assertSingleSentenceFact', () => {
  it('returns trimmed single sentence', () => {
    expect(assertSingleSentenceFact('  One clear sentence.  ')).toBe('One clear sentence.')
  })

  it('throws when multiple sentences detected', () => {
    expect(() => assertSingleSentenceFact('First sentence. Second sentence.')).toThrow(
      /exactly one sentence/
    )
  })

  it('throws on empty', () => {
    expect(() => assertSingleSentenceFact('   ')).toThrow(/empty/)
  })

  it('when no segment passes length filter but text is long enough, returns full trimmed text', () => {
    expect(assertSingleSentenceFact('abcdefgh')).toBe('abcdefgh')
  })

  it('throws when text too short for fallback path', () => {
    expect(() => assertSingleSentenceFact('short')).toThrow(/too short/)
  })
})
