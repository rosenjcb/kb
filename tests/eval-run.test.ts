import { describe, expect, it } from 'vitest'
import {
  buildCoverageAudit,
  derivedBase,
  formatScoreDelta,
  kbControlVerdict,
  matchesSuite,
  parseGraphCounts,
  parseQueryText,
  repoLeafNameFromUrl,
  sanitizeSlugPart,
  scoreMetric,
  sparkline,
  stripCliBanner,
  structuralMetric,
  worstQuestionGaps,
} from '../scripts/eval-run.mjs'

describe('sanitizeSlugPart', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeSlugPart('My Repo!')).toBe('my-repo')
  })
  it('trims leading and trailing hyphens', () => {
    expect(sanitizeSlugPart('--hello--')).toBe('hello')
  })
  it('truncates to 48 chars', () => {
    const long = 'a'.repeat(60)
    expect(sanitizeSlugPart(long).length).toBe(48)
  })
  it('returns "repo" for empty input', () => {
    expect(sanitizeSlugPart('')).toBe('repo')
    expect(sanitizeSlugPart('!!!')).toBe('repo')
  })
})

describe('repoLeafNameFromUrl', () => {
  it('extracts leaf from https URL', () => {
    expect(repoLeafNameFromUrl('https://github.com/raysan5/raylib.git')).toBe('raylib')
  })
  it('extracts leaf from git@ SCP URL', () => {
    expect(repoLeafNameFromUrl('git@github.com:raysan5/raylib.git')).toBe('raylib')
  })
  it('strips .git suffix', () => {
    expect(repoLeafNameFromUrl('https://github.com/org/myrepo.git')).toBe('myrepo')
  })
  it('falls back to "repo" for invalid URL', () => {
    expect(repoLeafNameFromUrl('')).toBe('repo')
  })
})

describe('derivedBase', () => {
  it('prefixes with eval-', () => {
    expect(derivedBase('raylib')).toBe('eval-raylib')
  })
  it('sanitizes the suite id', () => {
    expect(derivedBase('My Suite!')).toBe('eval-my-suite')
  })
})

describe('parseGraphCounts', () => {
  it('parses entities and relationships', () => {
    const text = 'Entities: 42\nRelationships: 17'
    expect(parseGraphCounts(text)).toEqual({ entities: 42, relationships: 17 })
  })
  it('returns 0 for missing counts', () => {
    expect(parseGraphCounts('no data here')).toEqual({ entities: 0, relationships: 0 })
  })
})

describe('parseQueryText', () => {
  const sampleOutput = [
    '🤖 KB Agent Harness',
    '',
    'stage> answer:start',
    'stage> answer:done 100ms',
    'Intro answer only.',
    'query> followup',
    'stage> retrieval-tool:start',
    'stage> retrieval-tool:done 50ms',
    'stage> answer-r2:start',
    'stage> answer-r2:done 200ms',
    'Full comprehensive answer here.',
    '---',
    'evidence> 10 facts',
    'retrieval> hybrid (passes:1)',
    'matches> 42 ranked facts',
    'sources> top 10 of 42 ranked: fact://abc; fact://def',
  ].join('\n')

  it('extracts the final answer, not the first partial one', () => {
    const r = parseQueryText(sampleOutput)
    expect(r.answer).toBe('Full comprehensive answer here.')
    expect(r.answer).not.toContain('Intro answer only')
  })
  it('extracts result count from matches line', () => {
    expect(parseQueryText(sampleOutput).result_count).toBe(42)
  })
  it('extracts provenance from sources line', () => {
    const r = parseQueryText(sampleOutput)
    expect(r.provenance).toContain('fact://abc')
    expect(r.provenance).toContain('fact://def')
  })
  it('extracts retrieval method', () => {
    expect(parseQueryText(sampleOutput).retrieval.method).toBe('hybrid')
  })
  it('returns null answer when no --- separator found', () => {
    expect(parseQueryText('no separator here').answer).toBeNull()
  })
})

describe('stripCliBanner', () => {
  it('strips prefix before first {', () => {
    expect(stripCliBanner('🤖 KB Agent\n{"ok":true}')).toBe('{"ok":true}')
  })
  it('passes through text that starts with {', () => {
    expect(stripCliBanner('{"ok":true}')).toBe('{"ok":true}')
  })
  it('returns trimmed text when no { present', () => {
    expect(stripCliBanner('  plain text  ')).toBe('plain text')
  })
})

describe('buildCoverageAudit', () => {
  it('returns coverage_ratio between 0 and 1', () => {
    const result = buildCoverageAudit('What are the main capabilities?', 'capabilities listed here', '')
    expect(result.coverage_ratio).toBeGreaterThanOrEqual(0)
    expect(result.coverage_ratio).toBeLessThanOrEqual(1)
  })
  it('returns full coverage when answer contains all facets', () => {
    const result = buildCoverageAudit('raylib graphics platform', 'raylib graphics platform support', '')
    expect(result.coverage_ratio).toBe(1)
    expect(result.missing_facets).toHaveLength(0)
  })
  it('handles empty question gracefully', () => {
    const result = buildCoverageAudit('', '', '')
    expect(result.coverage_ratio).toBe(1)
    expect(result.facets).toHaveLength(0)
  })
})

describe('scoreMetric', () => {
  const artifact = {
    aggregate_scores: {
      query: { mean_usefulness: 3.5, mean_correctness: 2.8, pass_rate_correctness_and_usefulness_at_least_3: 0.75 },
    },
  }
  it('extracts usefulness from query scores', () => {
    expect(scoreMetric(artifact, 'usefulness')).toBe(3.5)
  })
  it('extracts correctness', () => {
    expect(scoreMetric(artifact, 'correctness')).toBe(2.8)
  })
  it('extracts pass_rate', () => {
    expect(scoreMetric(artifact, 'pass_rate')).toBe(0.75)
  })
  it('falls back to combined when query is absent', () => {
    const a = { aggregate_scores: { combined: { mean_usefulness: 1.5 } } }
    expect(scoreMetric(a, 'usefulness')).toBe(1.5)
  })
  it('returns null when key is absent', () => {
    expect(scoreMetric({}, 'usefulness')).toBeNull()
  })
})

describe('structuralMetric', () => {
  const artifact = {
    run: { init_result: { written_docs: 10, graph_summary: { entities: 50, relationships: 80 } } },
    query_evaluation: [{ result_count: 6 }, { result_count: 4 }],
  }
  it('extracts docs count', () => {
    expect(structuralMetric(artifact, 'docs')).toBe(10)
  })
  it('extracts entities', () => {
    expect(structuralMetric(artifact, 'entities')).toBe(50)
  })
  it('computes avg_results across query_evaluation', () => {
    expect(structuralMetric(artifact, 'avg_results')).toBe(5)
  })
  it('returns null when absent', () => {
    expect(structuralMetric({}, 'docs')).toBeNull()
  })
})

describe('matchesSuite', () => {
  it('matches exact run.suite field', () => {
    const row = { id: 'kb-2026-01-01', artifact: { run: { suite: 'kb' } } }
    expect(matchesSuite(row, 'kb')).toBe(true)
    expect(matchesSuite(row, 'raylib')).toBe(false)
  })
  it('returns true for empty suite (no filter)', () => {
    const row = { id: 'anything', artifact: {} }
    expect(matchesSuite(row, '')).toBe(true)
  })
  it('falls back to id match when run.suite is absent', () => {
    const row = { id: 'raylib-2026-01-01', artifact: {} }
    expect(matchesSuite(row, 'raylib')).toBe(true)
  })
})

describe('formatScoreDelta', () => {
  it('formats positive and negative deltas', () => {
    expect(formatScoreDelta(0.25).trim()).toBe('+0.250')
    expect(formatScoreDelta(-0.5).trim()).toBe('-0.500')
  })
  it('returns placeholder for null', () => {
    expect(formatScoreDelta(null).trim()).toBe('-')
  })
})

describe('kbControlVerdict', () => {
  it('reports behind when all axes lose', () => {
    expect(
      kbControlVerdict(
        { pass: 0.5, correctness: 2.5, usefulness: 3 },
        { pass: 1, correctness: 4, usefulness: 4 }
      )
    ).toBe('behind control')
  })
  it('reports ahead when all axes tie or win', () => {
    expect(
      kbControlVerdict(
        { pass: 1, correctness: 4, usefulness: 4 },
        { pass: 1, correctness: 3.5, usefulness: 3.5 }
      )
    ).toBe('ahead or tied vs control')
  })
})

describe('worstQuestionGaps', () => {
  it('returns largest negative gaps first', () => {
    const kb = [{ scores: { correctness: 2 } }, { scores: { correctness: 4 } }]
    const ctrl = [{ scores: { correctness: 4 } }, { scores: { correctness: 3 } }]
    const gaps = worstQuestionGaps(kb, ctrl, ['a', 'b'], 2)
    expect(gaps[0].q).toBe(1)
    expect(gaps[0].gap).toBe(-2)
  })
})

describe('sparkline', () => {
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('')
  })
  it('returns all mid-char for flat input', () => {
    expect(sparkline([5, 5, 5])).toBe('▅▅▅')
  })
  it('returns a string of the right length for varied input', () => {
    const result = sparkline([1, 2, 3, 4])
    expect(result.length).toBe(4)
  })
})
