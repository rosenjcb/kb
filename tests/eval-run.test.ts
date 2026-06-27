import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildCoverageAudit,
  computeSuccessScore,
  computeAdequacyQuality,
  adequacyUtility,
  ADEQUACY_THRESHOLD,
  computeWeightedTokenTotal,
  conditionSideLabel,
  derivedBase,
  formatScoreDelta,
  formatCompactTokens,
  formatDurationMs,
  kbControlVerdict,
  logsCmd,
  matchesSuite,
  parseGraphCounts,
  parseLatestRunIdForCommand,
  parseQueryText,
  repoLeafNameFromUrl,
  sanitizeSlugPart,
  scoreMetric,
  SUCCESS_BUDGETS,
  SUCCESS_WEIGHTS,
  SUCCESS_TOKEN_CACHE_DISCOUNT,
  sparkline,
  stripCliBanner,
  structuralMetric,
  worstQuestionGaps,
  writeResearchResultsTex,
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
  it('extracts direct answer before --- when no stage> answer lines (one-shot synthesis)', () => {
    const output = [
      '🤖 KB Agent Harness',
      '',
      'running intent rewrite...',
      'running intent loop...',
      'Build/config evidence scaffold:',
      '- Prerequisites: cmake',
      '---',
      'evidence> 150 facts',
      'retrieval> hybrid (passes:1)',
      'matches> 10 ranked facts',
      'sources> top 10 of 10 ranked: fact://abc',
    ].join('\n')
    expect(parseQueryText(output).answer).toContain('Build/config evidence scaffold')
    expect(parseQueryText(output).answer).toContain('Prerequisites: cmake')
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
      query: {
        success_score: 0.751,
        mean_usefulness: 3.5,
        mean_correctness: 2.8,
        pass_rate_correctness_and_usefulness_at_least_3: 0.75,
      },
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
  it('extracts success_score', () => {
    expect(scoreMetric(artifact, 'success_score')).toBe(0.751)
  })
  it('falls back to combined when query is absent', () => {
    const a = { aggregate_scores: { combined: { mean_usefulness: 1.5 } } }
    expect(scoreMetric(a, 'usefulness')).toBe(1.5)
  })
  it('returns null when key is absent', () => {
    expect(scoreMetric({}, 'usefulness')).toBeNull()
  })
})

describe('computeSuccessScore', () => {
  it('weights default to 0.6 quality / 0.3 tokens / 0.1 speed summing to 1', () => {
    expect(SUCCESS_WEIGHTS.quality + SUCCESS_WEIGHTS.tokens + SUCCESS_WEIGHTS.speed).toBeCloseTo(1, 6)
  })

  it('maps perfect quality, zero tokens, zero time to 1.0', () => {
    const r = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 4,
      totalTokens: 0,
      totalDurationMs: 0,
    })
    expect(r.quality_score).toBe(1)
    expect(r.token_efficiency).toBe(1)
    expect(r.speed_score).toBe(1)
    expect(r.success_score).toBe(1)
  })

  it('blends the three components with the configured weights', () => {
    // adequacy at c=u=3 → Q_adeq = 1/(1+β) ≈ 0.833; tokens at half budget → 0.5; time at half budget → 0.5
    const r = computeSuccessScore({
      meanCorrectness: 3,
      meanUsefulness: 3,
      totalTokens: SUCCESS_BUDGETS.tokens / 2,
      totalDurationMs: SUCCESS_BUDGETS.timeMs / 2,
    })
    expect(r.quality_score).toBe(0.833)
    expect(r.token_efficiency).toBe(0.5)
    expect(r.speed_score).toBe(0.5)
    // 0.6*0.833 + 0.3*0.5 + 0.1*0.5 ≈ 0.7
    expect(r.success_score).toBe(0.7)
  })

  it('clamps token and speed sub-scores to 0 when over budget', () => {
    const r = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 4,
      totalTokens: SUCCESS_BUDGETS.tokens * 3,
      totalDurationMs: SUCCESS_BUDGETS.timeMs * 3,
    })
    expect(r.token_efficiency).toBe(0)
    expect(r.speed_score).toBe(0)
    // only quality contributes: 0.6 * 1.0 = 0.6
    expect(r.success_score).toBe(0.6)
  })

  it('returns null success_score when telemetry is missing', () => {
    const r = computeSuccessScore({ meanCorrectness: 4, meanUsefulness: 4 })
    expect(r.success_score).toBeNull()
    expect(r.token_efficiency).toBeNull()
    expect(r.speed_score).toBeNull()
    expect(r.quality_score).toBe(1)
  })

  it('weights cache reads at the MOEL discount when scoring control telemetry', () => {
    expect(SUCCESS_TOKEN_CACHE_DISCOUNT).toBe(0.1)
    const weighted = computeWeightedTokenTotal({
      inputTokens: 292946,
      outputTokens: 32472,
      cacheReadTokens: 2_437_286,
    })
    expect(weighted).toBeCloseTo(569_147, 0)
    const kb = computeSuccessScore({
      meanCorrectness: 3.325,
      meanUsefulness: 3.575,
      totalTokens: 119_629,
      totalDurationMs: 128_051,
    })
    const control = computeSuccessScore({
      meanCorrectness: 4,
      meanUsefulness: 4,
      totalTokens: weighted,
      totalDurationMs: 416_046,
    })
    expect(kb.success_score).toBe(0.888)
    expect(control.success_score).toBe(0.76)
    expect(kbControlVerdict({ success: kb.success_score }, { success: control.success_score })).toBe(
      'ahead of control'
    )
  })

  it('treats rubric scores at τ as adequate with diminishing returns above', () => {
    expect(adequacyUtility(ADEQUACY_THRESHOLD)).toBeCloseTo(0.833, 3)
    expect(adequacyUtility(4)).toBe(1)
    expect(adequacyUtility(2)).toBeCloseTo(2 / 3 / 1.2, 3)
    expect(computeAdequacyQuality(3, 3)).toBe(0.833)
    expect(computeAdequacyQuality(4, 4)).toBe(1)
  })
})

describe('kbControlVerdict — success-driven', () => {
  it('reports ahead when kb success exceeds control by >= 0.02', () => {
    expect(kbControlVerdict({ success: 0.78 }, { success: 0.74 })).toBe('ahead of control')
  })
  it('reports behind when kb success trails control by >= 0.02', () => {
    expect(kbControlVerdict({ success: 0.70 }, { success: 0.80 })).toBe('behind control')
  })
  it('reports on par within the 0.02 band', () => {
    expect(kbControlVerdict({ success: 0.751 }, { success: 0.75 })).toBe('on par with control')
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
  it('formats signed deltas', () => {
    expect(formatScoreDelta(0.25).trim()).toBe('+0.250')
    expect(formatScoreDelta(-0.5).trim()).toBe('-0.500')
  })
  it('returns dash for null', () => {
    expect(formatScoreDelta(null).trim()).toBe('-')
  })
})

describe('formatCompactTokens', () => {
  it('formats large counts compactly', () => {
    expect(formatCompactTokens(389900)).toBe('390k')
    expect(formatCompactTokens(534712)).toBe('535k')
    expect(formatCompactTokens(1_920_473)).toBe('1.9M')
  })
})

describe('formatDurationMs', () => {
  it('formats seconds and minutes', () => {
    expect(formatDurationMs(161935)).toBe('162s')
    expect(formatDurationMs(308582)).toBe('309s')
    expect(formatDurationMs(3600000)).toBe('60.0m')
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

describe('logsCmd', () => {
  it('filters logs by eval base with a generous limit', () => {
    expect(logsCmd('eval-kb')).toBe('logs list --base eval-kb --limit 10')
  })
})

describe('parseLatestRunIdForCommand', () => {
  const sample = [
    '🤖 KB Agent Harness',
    '',
    'run-abc init       eval-kb 2026-06-12 10:00:00',
    'run-def scan       eval-kb 2026-06-12 10:05:00',
    'run-ghi query      eval-kb 2026-06-12 10:06:00',
  ].join('\n')

  it('finds the latest init run id', () => {
    expect(parseLatestRunIdForCommand(sample, 'init')).toBe('run-abc')
  })

  it('finds the latest scan run id', () => {
    expect(parseLatestRunIdForCommand(sample, 'scan')).toBe('run-def')
  })

  it('returns null when command is absent', () => {
    expect(parseLatestRunIdForCommand(sample, 'publish')).toBeNull()
  })
})

describe('conditionSideLabel', () => {
  it('maps kb condition to K and control to N', () => {
    expect(conditionSideLabel('kb')).toBe('K')
    expect(conditionSideLabel('control')).toBe('N')
  })
})

describe('writeResearchResultsTex', () => {
  it('writes LaTeX macros from scored artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-results-'))
    const evalRoot = path.join(tmp, '.kb', 'evaluations')
    const runDir = path.join(evalRoot, 'raylib-test-run')
    fs.mkdirSync(runDir, { recursive: true })
    const artifact = {
      schema_version: 2,
      status: 'complete',
      created_at: '2026-06-26T12:00:00.000Z',
      run_label: 'raylib-test-run',
      repository: { name: 'raylib', commit: 'deadbeef1234567890' },
      run: {
        suite: 'raylib',
        init_result: {
          written_docs: 36,
          graph_summary: { entities: 100, relationships: 200 },
        },
      },
      query_scoring: {
        mode: 'llm_judge_avg_3',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      },
      aggregate_scores: {
        query: {
          success_score: 0.7,
          quality_score: 0.9,
          token_efficiency: 0.3,
          speed_score: 0.6,
          mean_correctness: 3.5,
          mean_usefulness: 3.2,
          pass_rate_correctness_and_usefulness_at_least_3: 0.75,
        },
      },
      kb_query_telemetry: {
        total_input_tokens: 100000,
        total_output_tokens: 5000,
        total_duration_ms: 120000,
      },
      control: {
        status: 'complete',
        agent: { name: 'cursor-agent', model: 'composer-2.5' },
        aggregate_scores: {
          query: {
            success_score: 0.75,
            quality_score: 1.0,
            token_efficiency: 0.32,
            speed_score: 0.31,
            mean_correctness: 4.0,
            mean_usefulness: 4.0,
            pass_rate_correctness_and_usefulness_at_least_3: 1.0,
          },
        },
        control_telemetry: {
          total_weighted_tokens: 678000,
          total_duration_ms: 400000,
        },
      },
    }
    fs.writeFileSync(path.join(runDir, 'artifact.json'), JSON.stringify(artifact))

    const repoRoot = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repoRoot, 'research', 'tables'), { recursive: true })
    fs.mkdirSync(path.join(repoRoot, 'eval', 'suites'), { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'eval', 'suites', 'raylib.yaml'),
      `id: raylib\ndisplay_name: raylib\nrepo_url: https://github.com/raysan5/raylib.git\nrubric_focus: raylib\nquestions:\n${Array.from({ length: 8 }, (_, i) => `- q${i + 1}`).join('\n')}`
    )

    const prevHome = process.env.HOME
    process.env.HOME = tmp
    try {
      const { outPath } = writeResearchResultsTex(repoRoot, { suites: ['raylib'] })
      const tex = fs.readFileSync(outPath, 'utf8')
      expect(tex).toContain('\\newcommand{\\RaylibRunId}{raylib-test-run}')
      expect(tex).toContain('\\newcommand{\\RaylibDeltaS}{-0.050}')
      expect(tex).toContain('\\newcommand{\\RaylibKS}{0.700}')
      expect(tex).toContain('\\newcommand{\\RaylibNS}{0.750}')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
