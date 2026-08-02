import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatAnswerTelemetryLog,
  readLatestKbQueryRunReport,
  runReportToAnswerTelemetry,
} from '../scripts/eval-shared.mjs'
import {
  buildCoverageAudit,
  buildQuestionTimeline,
  buildTimelineSummary,
  classifyStageTokens,
  parseRetrievalDetailTrace,
  computeSuccessScore,
  computeAdequacyQuality,
  adequacyUtility,
  ADEQUACY_THRESHOLD,
  computeWeightedTokenTotal,
  conditionSideLabel,
  derivedBase,
  resolveEvalInitPlan,
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
  DEFAULT_BENCHMARK_SUITES,
  parseArgs,
  parseSuiteListToken,
  dedupeSuites,
  resolveSuiteList,
  resolveParallelism,
  assertMultiSuiteArgsOk,
  buildChildArgv,
  buildMultiSuiteChildEnv,
} from '../scripts/eval-run.mjs'

describe('sanitizeSlugPart', () => {
  it('[TC-162] lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeSlugPart('My Repo!')).toBe('my-repo')
  })
  it('[TC-163] trims leading and trailing hyphens', () => {
    expect(sanitizeSlugPart('--hello--')).toBe('hello')
  })
  it('[TC-164] truncates to 48 chars', () => {
    const long = 'a'.repeat(60)
    expect(sanitizeSlugPart(long).length).toBe(48)
  })
  it('[TC-165] returns "repo" for empty input', () => {
    expect(sanitizeSlugPart('')).toBe('repo')
    expect(sanitizeSlugPart('!!!')).toBe('repo')
  })
})

describe('repoLeafNameFromUrl', () => {
  it('[TC-166] extracts leaf from https URL', () => {
    expect(repoLeafNameFromUrl('https://github.com/raysan5/raylib.git')).toBe('raylib')
  })
  it('[TC-167] extracts leaf from git@ SCP URL', () => {
    expect(repoLeafNameFromUrl('git@github.com:raysan5/raylib.git')).toBe('raylib')
  })
  it('[TC-168] strips .git suffix', () => {
    expect(repoLeafNameFromUrl('https://github.com/org/myrepo.git')).toBe('myrepo')
  })
  it('[TC-169] falls back to "repo" for invalid URL', () => {
    expect(repoLeafNameFromUrl('')).toBe('repo')
  })
})

describe('derivedBase', () => {
  it('[TC-170] prefixes with eval-', () => {
    expect(derivedBase('raylib')).toBe('eval-raylib')
  })
  it('[TC-171] sanitizes the suite id', () => {
    expect(derivedBase('My Suite!')).toBe('eval-my-suite')
  })
})

describe('resolveEvalInitPlan', () => {
  it('[TC-243] reuses an existing session when docs are present', () => {
    expect(resolveEvalInitPlan({ hasDocs: true })).toEqual({
      needsInit: false,
      wipeBase: false,
      evalMode: 'query',
    })
  })

  it('[TC-244] force-init wipes the base and runs a full init', () => {
    expect(resolveEvalInitPlan({ forceInit: true, hasDocs: true })).toEqual({
      needsInit: true,
      wipeBase: true,
      evalMode: 'all',
    })
  })

  it('[TC-245] missing docs still triggers init without a wipe', () => {
    expect(resolveEvalInitPlan({ hasDocs: false })).toEqual({
      needsInit: true,
      wipeBase: false,
      evalMode: 'all',
    })
  })
})

describe('parseGraphCounts', () => {
  it('[TC-172] parses entities and relationships', () => {
    const text = 'Entities: 42\nRelationships: 17'
    expect(parseGraphCounts(text)).toEqual({ entities: 42, relationships: 17 })
  })
  it('[TC-173] returns 0 for missing counts', () => {
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

  it('[TC-174] extracts the final answer, not the first partial one', () => {
    const r = parseQueryText(sampleOutput)
    expect(r.answer).toBe('Full comprehensive answer here.')
    expect(r.answer).not.toContain('Intro answer only')
  })
  it('[TC-175] extracts result count from matches line', () => {
    expect(parseQueryText(sampleOutput).result_count).toBe(42)
  })
  it('[TC-176] extracts provenance from sources line', () => {
    const r = parseQueryText(sampleOutput)
    expect(r.provenance).toContain('fact://abc')
    expect(r.provenance).toContain('fact://def')
  })
  it('[TC-177] extracts retrieval method', () => {
    expect(parseQueryText(sampleOutput).retrieval.method).toBe('hybrid')
  })
  it('[TC-178] returns null answer when no --- separator found', () => {
    expect(parseQueryText('no separator here').answer).toBeNull()
  })
  it('[TC-179] extracts direct answer before --- when no stage> answer lines (one-shot synthesis)', () => {
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

  it('[TC-180] parses remote-client sources> count and source> preview lines', () => {
    const output = [
      '🤖 KB Agent Harness',
      '',
      'host: 127.0.0.1:38117 │ base: eval-kb',
      '',
      'querying kb server...',
      'Default max passes is 24 (fact-abcdef1234567890).',
      '---',
      'sources> 3',
      'source> Environment knobs (facts deep loop)',
      'source> KB_FACTS_QUERY_MAX_ITERS',
      'retrieval> hybrid (facts-loop;passes:1)',
    ].join('\n')
    const r = parseQueryText(output)
    expect(r.answer).toContain('Default max passes is 24')
    expect(r.result_count).toBe(3)
    expect(r.provenance).toContain('Environment knobs (facts deep loop)')
    expect(r.provenance).toContain('fact-abcdef1234567890')
  })
})

describe('run timeline', () => {
  const report = {
    totalDurationMs: 30000,
    totalInputTokens: 40000,
    totalOutputTokens: 2000,
    totalEstimatedCostUsd: 0.12,
    stages: [
      // Deep-loop iteration stage: carries the loop wall-time but ~no tokens.
      {
        stage: 'query_truth:iter1',
        durationMs: 20000,
        inputTokens: 0,
        outputTokens: 0,
      },
      // Loop-LLM ("thinking") stage: tokens, but durationMs is logged as 0.
      {
        stage: 'query_truth:llm',
        durationMs: 0,
        inputTokens: 30000,
        outputTokens: 1200,
      },
      // Synthesis stage: fewer tokens, real duration.
      {
        stage: 'query_truth:answer-enrichment',
        durationMs: 4000,
        inputTokens: 10000,
        outputTokens: 800,
      },
    ],
    retrieval: {
      passes: 5,
      graphHops: 7,
      ponds: 2,
      stopReason: 'llm_judge_answerable',
      factsReturned: 20,
      hops: ['i1:merged=5', 'i2:merged=3'],
      curation: { kept: 20, dropped: 8, requeried: 1, rounds: 2, droppedFactIds: ['fact://z'] },
    },
  }

  it('[TC-233] classifyStageTokens splits thinking (:llm), synthesis (:answer-enrichment), and retrieval (:iterN)', () => {
    const s = classifyStageTokens(report)
    expect(s.thinking_tokens).toBe(31200)
    expect(s.synthesis_tokens).toBe(10800)
    expect(s.synthesis_ms).toBe(4000)
    expect(s.thinking_ms).toBe(0)
    // The :iter stage carries the loop wall-time, not synthesis/other.
    expect(s.retrieval_ms).toBe(20000)
    expect(s.retrieval_tokens).toBe(0)
  })

  it('[TC-234] parseRetrievalDetailTrace lifts loop counters from a retrieval detail line', () => {
    const t = parseRetrievalDetailTrace(
      'hybrid (facts-loop;passes:3;graph_hops:4;ponds:2;stop:frontier_exhausted;facts:15;curated:kept=15,dropped=3,requeried=0,rounds=1)'
    )
    expect(t?.passes).toBe(3)
    expect(t?.graph_hops).toBe(4)
    expect(t?.stop_reason).toBe('frontier_exhausted')
    expect(t?.curation?.dropped).toBe(3)
    expect(parseRetrievalDetailTrace('no loop here')).toBeNull()
  })

  it('[TC-235] buildQuestionTimeline joins stages with the trace and derives retrieval_ms', () => {
    const tl = buildQuestionTimeline(report, 1, 'What is X?', null)
    expect(tl.question_index).toBe(1)
    expect(tl.tokens.thinking).toBe(31200)
    expect(tl.tokens.synthesis).toBe(10800)
    // retrieval_ms comes from the :iter1 stage (20000ms), not total−synthesis.
    expect(tl.timing.retrieval_ms).toBe(20000)
    expect(tl.token_share.thinking).toBeGreaterThan(0.7)
    expect(tl.retrieval?.stop_reason).toBe('llm_judge_answerable')
    expect(tl.retrieval?.curation?.dropped_fact_ids).toEqual(['fact://z'])
  })

  it('[TC-236] buildQuestionTimeline falls back to the detail string when report.retrieval is absent', () => {
    const legacy = { ...report, retrieval: undefined }
    const tl = buildQuestionTimeline(
      legacy,
      2,
      'q2',
      'hybrid (facts-loop;passes:9;facts:12;curated:kept=12,dropped=1,requeried=0,rounds=1)'
    )
    expect(tl.retrieval?.passes).toBe(9)
    expect(tl.retrieval?.curation?.dropped).toBe(1)
  })

  it('[TC-237] buildTimelineSummary aggregates shares and flags a thinking-dominant run', () => {
    const timeline = [
      buildQuestionTimeline(report, 1, 'q1', null),
      buildQuestionTimeline(report, 2, 'q2', null),
    ]
    const summary = buildTimelineSummary(timeline)
    expect(summary?.questions).toBe(2)
    expect(summary?.thinking_token_share).toBeGreaterThan(0.5)
    expect(summary?.total_curator_dropped).toBe(16)
    // retrieval_time_share = iter (20s) / total (30s) per question ≈ 0.67
    expect(summary?.retrieval_time_share).toBeGreaterThan(0.6)
    expect(summary?.diagnosis.some(d => /thinking/i.test(d))).toBe(true)
    expect(buildTimelineSummary([])).toBeNull()
  })
})

describe('stripCliBanner', () => {
  it('[TC-180] strips prefix before first {', () => {
    expect(stripCliBanner('🤖 KB Agent\n{"ok":true}')).toBe('{"ok":true}')
  })
  it('[TC-181] passes through text that starts with {', () => {
    expect(stripCliBanner('{"ok":true}')).toBe('{"ok":true}')
  })
  it('[TC-182] returns trimmed text when no { present', () => {
    expect(stripCliBanner('  plain text  ')).toBe('plain text')
  })
})

describe('buildCoverageAudit', () => {
  it('[TC-183] returns coverage_ratio between 0 and 1', () => {
    const result = buildCoverageAudit('What are the main capabilities?', 'capabilities listed here', '')
    expect(result.coverage_ratio).toBeGreaterThanOrEqual(0)
    expect(result.coverage_ratio).toBeLessThanOrEqual(1)
  })
  it('[TC-184] returns full coverage when answer contains all facets', () => {
    const result = buildCoverageAudit('raylib graphics platform', 'raylib graphics platform support', '')
    expect(result.coverage_ratio).toBe(1)
    expect(result.missing_facets).toHaveLength(0)
  })
  it('[TC-185] handles empty question gracefully', () => {
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
  it('[TC-186] extracts usefulness from query scores', () => {
    expect(scoreMetric(artifact, 'usefulness')).toBe(3.5)
  })
  it('[TC-187] extracts correctness', () => {
    expect(scoreMetric(artifact, 'correctness')).toBe(2.8)
  })
  it('[TC-188] extracts pass_rate', () => {
    expect(scoreMetric(artifact, 'pass_rate')).toBe(0.75)
  })
  it('[TC-189] extracts success_score', () => {
    expect(scoreMetric(artifact, 'success_score')).toBe(0.751)
  })
  it('[TC-190] falls back to combined when query is absent', () => {
    const a = { aggregate_scores: { combined: { mean_usefulness: 1.5 } } }
    expect(scoreMetric(a, 'usefulness')).toBe(1.5)
  })
  it('[TC-191] returns null when key is absent', () => {
    expect(scoreMetric({}, 'usefulness')).toBeNull()
  })
})

describe('computeSuccessScore', () => {
  it('[TC-192] weights default to 0.6 quality / 0.3 tokens / 0.1 speed summing to 1', () => {
    expect(SUCCESS_WEIGHTS.quality + SUCCESS_WEIGHTS.tokens + SUCCESS_WEIGHTS.speed).toBeCloseTo(1, 6)
  })

  it('[TC-193] maps perfect quality, zero tokens, zero time to 1.0', () => {
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

  it('[TC-194] blends the three components with the configured weights', () => {
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

  it('[TC-195] clamps token and speed sub-scores to 0 when over budget', () => {
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

  it('[TC-196] returns null success_score when telemetry is missing', () => {
    const r = computeSuccessScore({ meanCorrectness: 4, meanUsefulness: 4 })
    expect(r.success_score).toBeNull()
    expect(r.token_efficiency).toBeNull()
    expect(r.speed_score).toBeNull()
    expect(r.quality_score).toBe(1)
  })

  it('[TC-197] weights cache reads at the MOEL discount when scoring control telemetry', () => {
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

  it('[TC-198] treats rubric scores at τ as adequate with diminishing returns above', () => {
    expect(adequacyUtility(ADEQUACY_THRESHOLD)).toBeCloseTo(0.833, 3)
    expect(adequacyUtility(4)).toBe(1)
    expect(adequacyUtility(2)).toBeCloseTo(2 / 3 / 1.2, 3)
    expect(computeAdequacyQuality(3, 3)).toBe(0.833)
    expect(computeAdequacyQuality(4, 4)).toBe(1)
  })
})

describe('kbControlVerdict — success-driven', () => {
  it('[TC-199] reports ahead when kb success exceeds control by >= 0.02', () => {
    expect(kbControlVerdict({ success: 0.78 }, { success: 0.74 })).toBe('ahead of control')
  })
  it('[TC-200] reports behind when kb success trails control by >= 0.02', () => {
    expect(kbControlVerdict({ success: 0.70 }, { success: 0.80 })).toBe('behind control')
  })
  it('[TC-201] reports on par within the 0.02 band', () => {
    expect(kbControlVerdict({ success: 0.751 }, { success: 0.75 })).toBe('on par with control')
  })
})

describe('structuralMetric', () => {
  const artifact = {
    run: { init_result: { written_docs: 10, graph_summary: { entities: 50, relationships: 80 } } },
    query_evaluation: [{ result_count: 6 }, { result_count: 4 }],
  }
  it('[TC-202] extracts docs count', () => {
    expect(structuralMetric(artifact, 'docs')).toBe(10)
  })
  it('[TC-203] extracts entities', () => {
    expect(structuralMetric(artifact, 'entities')).toBe(50)
  })
  it('[TC-204] computes avg_results across query_evaluation', () => {
    expect(structuralMetric(artifact, 'avg_results')).toBe(5)
  })
  it('[TC-205] returns null when absent', () => {
    expect(structuralMetric({}, 'docs')).toBeNull()
  })
})

describe('matchesSuite', () => {
  it('[TC-206] matches exact run.suite field', () => {
    const row = { id: 'kb-2026-01-01', artifact: { run: { suite: 'kb' } } }
    expect(matchesSuite(row, 'kb')).toBe(true)
    expect(matchesSuite(row, 'raylib')).toBe(false)
  })
  it('[TC-207] returns true for empty suite (no filter)', () => {
    const row = { id: 'anything', artifact: {} }
    expect(matchesSuite(row, '')).toBe(true)
  })
  it('[TC-208] falls back to id match when run.suite is absent', () => {
    const row = { id: 'raylib-2026-01-01', artifact: {} }
    expect(matchesSuite(row, 'raylib')).toBe(true)
  })
})

describe('formatScoreDelta', () => {
  it('[TC-209] formats signed deltas', () => {
    expect(formatScoreDelta(0.25).trim()).toBe('+0.250')
    expect(formatScoreDelta(-0.5).trim()).toBe('-0.500')
  })
  it('[TC-210] returns dash for null', () => {
    expect(formatScoreDelta(null).trim()).toBe('-')
  })
})

describe('formatCompactTokens', () => {
  it('[TC-211] formats large counts compactly', () => {
    expect(formatCompactTokens(389900)).toBe('390k')
    expect(formatCompactTokens(534712)).toBe('535k')
    expect(formatCompactTokens(1_920_473)).toBe('1.9M')
  })
})

describe('formatDurationMs', () => {
  it('[TC-212] formats seconds and minutes', () => {
    expect(formatDurationMs(161935)).toBe('162s')
    expect(formatDurationMs(308582)).toBe('309s')
    expect(formatDurationMs(3600000)).toBe('60.0m')
  })
})

describe('kbControlVerdict', () => {
  it('[TC-213] reports behind when all axes lose', () => {
    expect(
      kbControlVerdict(
        { pass: 0.5, correctness: 2.5, usefulness: 3 },
        { pass: 1, correctness: 4, usefulness: 4 }
      )
    ).toBe('behind control')
  })
  it('[TC-214] reports ahead when all axes tie or win', () => {
    expect(
      kbControlVerdict(
        { pass: 1, correctness: 4, usefulness: 4 },
        { pass: 1, correctness: 3.5, usefulness: 3.5 }
      )
    ).toBe('ahead or tied vs control')
  })
})

describe('worstQuestionGaps', () => {
  it('[TC-215] returns largest negative gaps first', () => {
    const kb = [{ scores: { correctness: 2 } }, { scores: { correctness: 4 } }]
    const ctrl = [{ scores: { correctness: 4 } }, { scores: { correctness: 3 } }]
    const gaps = worstQuestionGaps(kb, ctrl, ['a', 'b'], 2)
    expect(gaps[0].q).toBe(1)
    expect(gaps[0].gap).toBe(-2)
  })
})

describe('sparkline', () => {
  it('[TC-216] returns empty string for empty input', () => {
    expect(sparkline([])).toBe('')
  })
  it('[TC-217] returns all mid-char for flat input', () => {
    expect(sparkline([5, 5, 5])).toBe('▅▅▅')
  })
  it('[TC-218] returns a string of the right length for varied input', () => {
    const result = sparkline([1, 2, 3, 4])
    expect(result.length).toBe(4)
  })
})

describe('logsCmd', () => {
  it('[TC-219] filters logs by eval base with a generous limit', () => {
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

  it('[TC-220] finds the latest init run id', () => {
    expect(parseLatestRunIdForCommand(sample, 'init')).toBe('run-abc')
  })

  it('[TC-221] finds the latest scan run id', () => {
    expect(parseLatestRunIdForCommand(sample, 'scan')).toBe('run-def')
  })

  it('[TC-222] returns null when command is absent', () => {
    expect(parseLatestRunIdForCommand(sample, 'publish')).toBeNull()
  })
})

describe('conditionSideLabel', () => {
  it('[TC-223] maps kb condition to K and control to N', () => {
    expect(conditionSideLabel('kb')).toBe('K')
    expect(conditionSideLabel('control')).toBe('N')
  })
})

describe('writeResearchResultsTex', () => {
  function seedSuiteYaml(repoRoot: string, suiteId: string) {
    fs.mkdirSync(path.join(repoRoot, 'eval', 'suites'), { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'eval', 'suites', `${suiteId}.yaml`),
      `id: ${suiteId}\ndisplay_name: ${suiteId}\nrepo_url: https://example.com/${suiteId}.git\nrubric_focus: ${suiteId}\nquestions:\n${Array.from({ length: 8 }, (_, i) => `- q${i + 1}`).join('\n')}`
    )
  }

  function writeArtifact(home: string, runName: string, artifact: object) {
    const runDir = path.join(home, '.kb', 'evaluations', runName)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'artifact.json'), JSON.stringify(artifact))
  }

  it('[TC-224] writes LaTeX macros from scored artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-results-'))
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
    writeArtifact(tmp, 'raylib-test-run', artifact)

    const repoRoot = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repoRoot, 'research', 'tables'), { recursive: true })
    seedSuiteYaml(repoRoot, 'raylib')

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

  it('[TC-225] preserves prior N macros when latest run skips or partially completes control', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-results-merge-'))
    const repoRoot = path.join(tmp, 'repo')
    const outPath = path.join(repoRoot, 'research', 'tables', 'results.tex')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    seedSuiteYaml(repoRoot, 'raylib')

    // Prior paper row: complete K+N from an older control agent.
    fs.writeFileSync(
      outPath,
      [
        '% Auto-generated harvest result macros — do not edit by hand.',
        '',
        '\\newcommand{\\ResultsUpdated}{July 11, 2026}',
        '\\newcommand{\\ResultsJudge}{LLM-as-judge}',
        '\\newcommand{\\ResultsControlStatus}{paired}',
        '',
        '%% ── suite raylib ──',
        '\\newcommand{\\RaylibRunId}{raylib-old}',
        '\\newcommand{\\RaylibRunDate}{July 11, 2026}',
        '\\newcommand{\\RaylibSuite}{\\texttt{raylib}}',
        '\\newcommand{\\RaylibCommit}{\\texttt{aaaaaaa}}',
        '\\newcommand{\\RaylibControlCollected}{yes}',
        '\\newcommand{\\RaylibControlAgent}{Headless agent: cursor-agent (composer-2.5)}',
        '\\newcommand{\\RaylibDeltaS}{+0.100}',
        '\\newcommand{\\RaylibKS}{0.800}',
        '\\newcommand{\\RaylibKQadeq}{0.700}',
        '\\newcommand{\\RaylibKEtok}{0.900}',
        '\\newcommand{\\RaylibKEspeed}{0.600}',
        '\\newcommand{\\RaylibKPass}{0.500}',
        '\\newcommand{\\RaylibKCorrectness}{3.000}',
        '\\newcommand{\\RaylibKUsefulness}{3.000}',
        '\\newcommand{\\RaylibKRelevance}{3.000}',
        '\\newcommand{\\RaylibKTokens}{10{,}000}',
        '\\newcommand{\\RaylibKDurationSec}{100}',
        '\\newcommand{\\RaylibKDocs}{1}',
        '\\newcommand{\\RaylibKEntities}{2}',
        '\\newcommand{\\RaylibKRels}{3}',
        '\\newcommand{\\RaylibNS}{0.700}',
        '\\newcommand{\\RaylibNQadeq}{1.000}',
        '\\newcommand{\\RaylibNEtok}{0.200}',
        '\\newcommand{\\RaylibNEspeed}{0.000}',
        '\\newcommand{\\RaylibNPass}{1.000}',
        '\\newcommand{\\RaylibNCorrectness}{4.000}',
        '\\newcommand{\\RaylibNUsefulness}{4.000}',
        '\\newcommand{\\RaylibNRelevance}{4.000}',
        '\\newcommand{\\RaylibNTokens}{800{,}000}',
        '\\newcommand{\\RaylibNDurationSec}{900}',
        '\\newcommand{\\RaylibNDocs}{---}',
        '\\newcommand{\\RaylibNEntities}{---}',
        '\\newcommand{\\RaylibNRels}{---}',
        '',
      ].join('\n')
    )

    // Newest harvest: refreshed K scores, control only partial (must not overwrite N).
    writeArtifact(tmp, 'raylib-new-k', {
      schema_version: 2,
      status: 'complete',
      created_at: '2026-07-15T12:00:00.000Z',
      run_label: 'raylib-new-k',
      repository: { name: 'raylib', commit: 'bbbbbbb1234567890' },
      run: { suite: 'raylib', init_result: { written_docs: 0, graph_summary: { entities: 9, relationships: 8 } } },
      query_scoring: { mode: 'llm_judge_avg_3', provider: 'gemini', model: 'gemini-2.5-flash' },
      aggregate_scores: {
        query: {
          success_score: 0.65,
          quality_score: 0.48,
          token_efficiency: 0.98,
          speed_score: 0.66,
          mean_correctness: 1.2,
          mean_usefulness: 1.1,
          mean_relevance: 2.8,
          pass_rate_correctness_and_usefulness_at_least_3: 0.09,
        },
      },
      kb_query_telemetry: {
        total_input_tokens: 10000,
        total_output_tokens: 1000,
        total_duration_ms: 50000,
      },
      control: {
        status: 'partial',
        agent: { name: 'claude-code', model: 'claude-sonnet-5' },
        aggregate_scores: {
          query: {
            success_score: 0.1,
            quality_score: 0.1,
            token_efficiency: 0.9,
            speed_score: 0.5,
            mean_correctness: 0.5,
            mean_usefulness: 0.5,
            mean_relevance: 0.5,
            pass_rate_correctness_and_usefulness_at_least_3: 0,
          },
        },
        control_telemetry: { total_weighted_tokens: 1, total_duration_ms: 1 },
      },
    })

    const prevHome = process.env.HOME
    process.env.HOME = tmp
    try {
      writeResearchResultsTex(repoRoot, { suites: ['raylib'], outPath })
      const tex = fs.readFileSync(outPath, 'utf8')
      expect(tex).toContain('\\newcommand{\\RaylibRunId}{raylib-new-k}')
      expect(tex).toContain('\\newcommand{\\RaylibKS}{0.650}')
      // Prior complete N preserved; partial control must not replace it.
      expect(tex).toContain('\\newcommand{\\RaylibNS}{0.700}')
      expect(tex).toContain('\\newcommand{\\RaylibNTokens}{800{,}000}')
      expect(tex).toContain(
        '\\newcommand{\\RaylibControlAgent}{Headless agent: cursor-agent (composer-2.5)}'
      )
      // ΔS recomputed from new K − preserved N: 0.650 − 0.700 = −0.050
      expect(tex).toContain('\\newcommand{\\RaylibDeltaS}{-0.050}')
      expect(tex).toContain('\\newcommand{\\RaylibControlCollected}{yes}')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('answer telemetry logging', () => {
  it('[TC-246] runReportToAnswerTelemetry maps RunReport fields', () => {
    expect(
      runReportToAnswerTelemetry({
        totalInputTokens: 1200,
        totalOutputTokens: 340,
        totalEstimatedCostUsd: 0.0123,
        totalDurationMs: 45000,
      })
    ).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: null,
      num_turns: null,
      total_cost_usd: 0.0123,
      duration_ms: 45000,
    })
  })

  it('[TC-247] formatAnswerTelemetryLog matches control-style kb query lines', () => {
    const line = formatAnswerTelemetryLog({
      input_tokens: 1200,
      output_tokens: 340,
      total_cost_usd: 0.0123,
      duration_ms: 45000,
    })
    expect(line).toBe('in=1200 out=340 cost=$0.0123 45s')
  })

  it('[TC-248] readLatestKbQueryRunReport returns newest query for base', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-logs-'))
    const logsDir = path.join(tmp, '.kb', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const older = {
      command: 'query',
      base: 'eval-raylib',
      finishedAt: '2026-07-05T12:00:00.000Z',
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalDurationMs: 1000,
    }
    const newer = {
      command: 'query',
      base: 'eval-raylib',
      finishedAt: '2026-07-05T13:00:00.000Z',
      totalInputTokens: 99,
      totalOutputTokens: 11,
      totalDurationMs: 2000,
    }
    fs.writeFileSync(
      path.join(logsDir, '2026-07-05.jsonl'),
      `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`
    )
    const prevHome = process.env.HOME
    process.env.HOME = tmp
    try {
      expect(readLatestKbQueryRunReport('eval-raylib')?.totalInputTokens).toBe(99)
      expect(readLatestKbQueryRunReport('eval-kb')).toBeNull()
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('multi-suite parallel batch', () => {
  it('parseSuiteListToken splits commas and whitespace', () => {
    expect(parseSuiteListToken('raylib,kb, fzf')).toEqual(['raylib', 'kb', 'fzf'])
    expect(parseSuiteListToken('raylib kb')).toEqual(['raylib', 'kb'])
  })

  it('dedupeSuites preserves first-seen order', () => {
    expect(dedupeSuites(['kb', 'raylib', 'kb', 'fzf'])).toEqual(['kb', 'raylib', 'fzf'])
  })

  it('parseArgs accepts --suites, repeated --suite, --all-suites, --parallel, --sequential', () => {
    const multi = parseArgs(['node', 'eval-run.mjs', '--suites', 'raylib,kb', '--parallel', '3'])
    expect(multi.suites).toEqual(['raylib', 'kb'])
    expect(multi.parallel).toBe(3)

    const repeated = parseArgs(['node', 'eval-run.mjs', '--suite', 'raylib', '--suite', 'kb'])
    expect(repeated.suites).toEqual(['raylib', 'kb'])

    const all = parseArgs(['node', 'eval-run.mjs', '--all-suites', '--sequential'])
    expect(all.allSuites).toBe(true)
    expect(all.sequential).toBe(true)

    const bareParallel = parseArgs(['node', 'eval-run.mjs', '--all-suites', '--parallel'])
    expect(bareParallel.parallel).toBe(0)

    const single = parseArgs(['node', 'eval-run.mjs', '--suite', 'raylib'])
    expect(single.suite).toBe('raylib')
    expect(single.suites).toEqual(['raylib'])
  })

  it('resolveSuiteList: --all-suites returns the 10 benchmark suites', () => {
    expect(DEFAULT_BENCHMARK_SUITES).toHaveLength(10)
    expect(DEFAULT_BENCHMARK_SUITES).not.toContain('generic')
    expect(DEFAULT_BENCHMARK_SUITES).toContain('kestra')
    expect(DEFAULT_BENCHMARK_SUITES).toContain('datasette')
    expect(DEFAULT_BENCHMARK_SUITES).not.toContain('nifi')
    expect(DEFAULT_BENCHMARK_SUITES).not.toContain('duckdb')
    expect(resolveSuiteList({ allSuites: true, suites: ['kb'] })).toEqual([
      ...DEFAULT_BENCHMARK_SUITES,
    ])
    expect(resolveSuiteList({ allSuites: false, suites: ['kb', 'raylib', 'kb'] })).toEqual([
      'kb',
      'raylib',
    ])
  })

  it('resolveParallelism defaults to full parallel; --sequential and caps work', () => {
    expect(resolveParallelism({ suiteCount: 10, parallel: null, sequential: false, env: {} })).toBe(
      10
    )
    expect(resolveParallelism({ suiteCount: 10, parallel: null, sequential: true, env: {} })).toBe(1)
    expect(resolveParallelism({ suiteCount: 10, parallel: 4, sequential: false, env: {} })).toBe(4)
    expect(resolveParallelism({ suiteCount: 10, parallel: 0, sequential: false, env: {} })).toBe(10)
    expect(
      resolveParallelism({
        suiteCount: 10,
        parallel: null,
        sequential: false,
        env: { KB_EVAL_PARALLEL: '3' },
      })
    ).toBe(3)
    expect(resolveParallelism({ suiteCount: 1, parallel: 99, sequential: false, env: {} })).toBe(1)
  })

  it('assertMultiSuiteArgsOk rejects single-suite-only flags', () => {
    expect(() =>
      assertMultiSuiteArgsOk({ repo: 'https://example.com/r.git' }, ['raylib', 'kb'])
    ).toThrow(/--repo/)
    expect(() =>
      assertMultiSuiteArgsOk({ repo: 'https://example.com/r.git' }, ['raylib'])
    ).not.toThrow()
  })

  it('buildChildArgv forwards control knobs and strips multi-suite flags', () => {
    const argv = buildChildArgv('raylib', {
      label: 'composer-2.5',
      autoScore: true,
      scoreRuns: 3,
      controlAgent: 'cursor',
      controlModel: 'composer-2.5',
      skipControl: false,
      forceInit: true,
    })
    expect(argv).toEqual(
      expect.arrayContaining([
        '--suite',
        'raylib',
        '--label',
        'composer-2.5',
        '--control-agent',
        'cursor',
        '--control-model',
        'composer-2.5',
        '--force-init',
        '--auto-score',
      ])
    )
    expect(argv).not.toContain('--all-suites')
    expect(argv).not.toContain('--parallel')
    expect(argv).not.toContain('--sequential')
  })

  it('[TC-238] buildMultiSuiteChildEnv keeps shared multi-base attach URL by default', () => {
    const env = buildMultiSuiteChildEnv({
      PATH: '/usr/bin',
      KB_EVAL_SERVER_URL: 'http://127.0.0.1:38117',
      KB_EVAL_ATTACH_URL: 'http://127.0.0.1:38117',
      KB_EVAL_SERVER_PORT: '38117',
      GEMINI_API_KEY: 'x',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GEMINI_API_KEY).toBe('x')
    expect(env.KB_EVAL_SERVER_URL).toBe('http://127.0.0.1:38117')
    expect(env.KB_EVAL_ATTACH_URL).toBe('http://127.0.0.1:38117')
    expect(env.KB_EVAL_SERVER_PORT).toBeUndefined()
  })

  it('[TC-239] buildMultiSuiteChildEnv strips attach pins in --per-suite-server mode', () => {
    const env = buildMultiSuiteChildEnv(
      {
        PATH: '/usr/bin',
        KB_EVAL_SERVER_URL: 'http://127.0.0.1:38117',
        KB_EVAL_ATTACH_URL: 'http://127.0.0.1:38117',
        KB_EVAL_SERVER_PORT: '38117',
        GEMINI_API_KEY: 'x',
      },
      { sharedServer: false }
    )
    expect(env.KB_EVAL_SERVER_URL).toBeUndefined()
    expect(env.KB_EVAL_ATTACH_URL).toBeUndefined()
    expect(env.KB_EVAL_SERVER_PORT).toBeUndefined()
  })

  it('[TC-240] buildChildArgv forwards --skip-scan', () => {
    const argv = buildChildArgv('raylib', {
      skipScan: true,
      skipControl: true,
      autoScore: true,
    })
    expect(argv).toContain('--skip-scan')
    expect(argv).toContain('--skip-control')
  })
})
