import { describe, expect, it } from 'vitest'
// @ts-expect-error — eval harness is plain ESM JS, no type declarations
import {
  attachGradedRetrievalScores,
  computeRetrievalCostMetrics,
  normalizeCitedPath,
  normalizeGoldFiles,
  normalizeGoldScope,
  normalizeProbes,
  normalizeSuiteDoc,
  parseRetrievalInstrumentation,
  pathMatchesGold,
  scoreGoldScope,
  scoreGradedRetrieval,
  summarizeGradedRetrieval,
  summarizeProbeCoverage,
} from '../../scripts/eval-shared.mjs'

describe('gold_files suite schema', () => {
  it('[TC-GR01] Given no gold_files key, then every question is null (axis skipped)', () => {
    const gold = normalizeGoldFiles(undefined, 3, 't.yaml')
    expect(gold).toEqual([null, null, null])
  })

  it('[TC-GR02] Given a mismatched gold_files length, then normalize throws', () => {
    expect(() => normalizeGoldFiles([[{ path: 'a.ts', role: 'must_open' }]], 2, 't.yaml')).toThrow(
      /same length/
    )
  })

  it('[TC-GR03] Given valid gold_files/probes/gold_scope, then normalizeSuiteDoc keeps them', () => {
    const doc = normalizeSuiteDoc(
      {
        id: 't',
        rubric_focus: 'test',
        questions: ['q1', 'q2'],
        gold_files: [
          [{ path: 'src/a.ts', role: 'must_open', symbol: 'foo' }],
          null,
        ],
        gold_scope: [['@kb/server'], null],
        probes: [['wrong_base', 'scope_inference'], null],
      },
      't.yaml'
    )
    expect(doc.goldFiles[0]).toEqual([{ path: 'src/a.ts', role: 'must_open', symbol: 'foo' }])
    expect(doc.goldFiles[1]).toBeNull()
    expect(doc.goldScope[0]).toEqual(['@kb/server'])
    expect(doc.probes[0]).toEqual(['wrong_base', 'scope_inference'])
  })

  it('[TC-GR13] Given an unknown probe id, then normalizeProbes throws', () => {
    expect(() => normalizeProbes([['not_a_real_probe']], 1, 't.yaml')).toThrow(/unknown probe/)
  })

  it('[TC-GR14] Given gold_scope strings, then normalizeGoldScope accepts them', () => {
    expect(normalizeGoldScope(['@kb/server', null], 2, 't.yaml')).toEqual([['@kb/server'], null])
  })
})

describe('path matching', () => {
  it('[TC-GR04] Given a clone-prefixed citation, then it matches the gold suffix (case-sensitive)', () => {
    expect(
      pathMatchesGold(
        'kestra-2026-08-16-kestra/ui/src/components/flows/FlowCreate.vue · handleImportSubmit',
        'ui/src/components/flows/FlowCreate.vue'
      )
    ).toBe(true)
    expect(normalizeCitedPath('a/b.ts · sym')).toBe('a/b.ts')
    // Case-sensitive: different casing must not match.
    expect(pathMatchesGold('UI/Src/A.ts', 'ui/src/a.ts')).toBe(false)
  })
})

describe('scoreGradedRetrieval', () => {
  const gold = [
    { path: 'packages/kb-core/src/tools/hybrid-retriever.ts', role: 'must_open' },
    { path: 'packages/kb-core/src/tools/sqlite-kb-index.ts', role: 'must_open' },
    { path: 'README.md', role: 'supporting' },
  ]

  it('[TC-GR05] Given empty gold, then score returns null', () => {
    expect(scoreGradedRetrieval(['a.ts'], null)).toBeNull()
    expect(scoreGradedRetrieval(['a.ts'], [])).toBeNull()
  })

  it('[TC-GR06] Given perfect top ranks, then recall/precision/ndcg are high', () => {
    const scored = scoreGradedRetrieval(
      [
        'packages/kb-core/src/tools/hybrid-retriever.ts',
        'packages/kb-core/src/tools/sqlite-kb-index.ts',
        'README.md',
      ],
      gold
    )
    expect(scored?.recall_at[10]).toBe(1)
    expect(scored?.recall_at[1]).toBe(0.5)
    expect(scored?.must_open_found).toBe(2)
    expect(scored?.first_gold_rank).toBe(1)
    expect(scored?.mrr).toBe(1)
    expect(scored?.ndcg_at_10).toBeGreaterThan(0.9)
    expect(scored?.precision_at[10]).toBeCloseTo(0.3, 4)
  })

  it('[TC-GR07] Given a wrong gold path, then recall drops (negative check)', () => {
    const good = scoreGradedRetrieval(
      ['packages/kb-core/src/tools/hybrid-retriever.ts'],
      [{ path: 'packages/kb-core/src/tools/hybrid-retriever.ts', role: 'must_open' }]
    )
    const bad = scoreGradedRetrieval(
      ['packages/kb-core/src/tools/hybrid-retriever.ts'],
      [{ path: 'packages/kb-core/src/tools/DOES-NOT-EXIST.ts', role: 'must_open' }]
    )
    expect(good?.recall_at[10]).toBe(1)
    expect(bad?.recall_at[10]).toBe(0)
    expect(bad?.miss_paths).toEqual(['packages/kb-core/src/tools/DOES-NOT-EXIST.ts'])
  })

  it('[TC-GR08] Given decoy docs only, then must_open recall is zero and first_gold_rank is null', () => {
    const scored = scoreGradedRetrieval(['README.md', 'AGENTS.md', 'CHANGELOG.md'], gold)
    expect(scored?.recall_at[10]).toBe(0)
    expect(scored?.must_open_found).toBe(0)
    expect(scored?.first_gold_rank).toBeNull() // must_open only
    expect(scored?.precision_at[10]).toBeCloseTo(0.1, 4)
  })

  it('[TC-GR15] Given fact- ids in provenance, then they are filtered before scoring', () => {
    const scored = scoreGradedRetrieval(
      ['fact-abcdef0123456789', 'packages/kb-core/src/tools/hybrid-retriever.ts'],
      [{ path: 'packages/kb-core/src/tools/hybrid-retriever.ts', role: 'must_open' }]
    )
    expect(scored?.first_gold_rank).toBe(1)
    expect(scored?.cited_total).toBe(1)
  })
})

describe('retrieval instrumentation (absent vs zero)', () => {
  it('[TC-GR16] Given no decoys key, then decoys is null (guard off), not zero', () => {
    const off = parseRetrievalInstrumentation(
      'hybrid:docs=1;curated:kept=1,dropped=0,requeried=0,rounds=1;scope:@kb/client;lanes:4'
    )
    expect(off.decoys).toBeNull()
    expect(off.causal).toBeNull()
    expect(off.scope).toBe('@kb/client')
    expect(off.scope_landings).toEqual(['@kb/client'])
  })

  it('[TC-GR17] Given decoys:0 and causal:miss, then guard ran but found nothing', () => {
    const ran = parseRetrievalInstrumentation(
      'curated:kept=1,dropped=0,requeried=0,rounds=1;causal:miss;scope:@kb/client;lanes:4;decoys:0'
    )
    expect(ran.decoys).toBe(0)
    expect(ran.causal).toBe('miss')
  })

  it('[TC-GR18] Given gold_scope @kb/server and landed @kb/client, then scope_score misses', () => {
    const score = scoreGoldScope(['@kb/client'], ['@kb/server'])
    expect(score?.matched).toBe(false)
    expect(score?.miss_scopes).toEqual(['@kb/server'])
  })
})

describe('summarizeGradedRetrieval + cost + probes', () => {
  it('[TC-GR09] Given mixed shapes, then by_shape keeps investigative visible', () => {
    const qe = [
      { question_id: 1, shape: 'conceptual', provenance: ['a.ts'] },
      {
        question_id: 2,
        shape: 'investigative',
        provenance: ['packages/kb-core/src/tools/tree-sitter-indexer.ts'],
      },
      { question_id: 3, shape: 'investigative', provenance: ['README.md'] },
    ]
    const golds = [
      null,
      [{ path: 'packages/kb-core/src/tools/tree-sitter-indexer.ts', role: 'must_open' }],
      [{ path: 'packages/kb-core/src/tools/hybrid-retriever.ts', role: 'must_open' }],
    ]
    const { graded: summary } = attachGradedRetrievalScores(qe, golds)
    expect(summary?.questions_with_gold).toBe(2)
    expect(summary?.by_shape?.investigative?.n).toBe(2)
    expect(summary?.by_shape?.investigative?.mean_recall_at_k).toBe(0.5)
    expect(summary?.by_shape?.conceptual).toBeUndefined()
  })

  it('[TC-GR10] Given zero must_open hits, then wasted_budget_share is 1', () => {
    const qe = [
      { question_id: 1, retrieval_scores: { must_open_recovered: 0, n_must_open: 1 } },
      { question_id: 2, retrieval_scores: { must_open_recovered: 0, n_must_open: 1 } },
    ]
    const cost = computeRetrievalCostMetrics(qe, {
      totalTokens: 1000,
      timeline: [
        { question_index: 1, total_input_tokens: 400, total_output_tokens: 100 },
        { question_index: 2, total_input_tokens: 400, total_output_tokens: 100 },
      ],
    })
    expect(cost?.wasted_budget_share).toBe(1)
    expect(cost?.tokens_per_must_open_file).toBeNull()
    expect(cost?.questions_with_zero_must_open).toBe(2)
  })

  it('[TC-GR11] Given recovered files, then tokens_per_must_open_file is total/recovered', () => {
    const qe = [
      { question_id: 1, retrieval_scores: { must_open_recovered: 2 } },
      { question_id: 2, retrieval_scores: { must_open_recovered: 0 } },
    ]
    const cost = computeRetrievalCostMetrics(qe, { totalTokens: 1000 })
    expect(cost?.tokens_per_must_open_file).toBe(500)
    expect(cost?.wasted_budget_share).toBe(0.5)
  })

  it('[TC-GR19] Given decoy_guard probes with decoys:0, then coverage reports ran_but_missed not off', () => {
    const qe = [
      {
        question_id: 25,
        probes: ['decoy_guard'],
        retrieval: { detail: 'causal:miss;scope:@kb/client;decoys:0' },
        provenance: [],
      },
      {
        question_id: 8,
        probes: ['decoy_guard'],
        retrieval: { detail: 'causal:miss;scope:@kb/client' },
        provenance: [],
      },
    ]
    const { probe_coverage } = attachGradedRetrievalScores(qe, [null, null], {
      probesList: [['decoy_guard'], ['decoy_guard']],
    })
    expect(probe_coverage?.by_probe?.decoy_guard?.target_questions).toBe(2)
    expect(probe_coverage?.by_probe?.decoy_guard?.ran_but_missed).toBe(1)
    expect(probe_coverage?.by_probe?.decoy_guard?.off).toBe(1)
  })

  it('[TC-GR20] Given causal_guard targets and all causal:miss, then fired is 0 (non-experiment visible)', () => {
    const qe = [
      {
        question_id: 13,
        probes: ['causal_guard'],
        retrieval: { detail: 'causal:miss;scope:x;decoys:0' },
        provenance: [],
      },
    ]
    const { probe_coverage } = attachGradedRetrievalScores(qe, [null], {
      probesList: [['causal_guard']],
    })
    expect(probe_coverage?.by_probe?.causal_guard).toEqual(
      expect.objectContaining({
        target_questions: 1,
        fired: 0,
        ran_but_missed: 1,
        off: 0,
      })
    )
    // sanity: summarizeProbeCoverage alone also works on pre-attached rows
    expect(summarizeProbeCoverage(qe)?.by_probe?.causal_guard?.fired).toBe(0)
  })
})

describe('summarizeGradedRetrieval empty', () => {
  it('[TC-GR12] Given no scored rows, then summarize returns null', () => {
    expect(summarizeGradedRetrieval([{ provenance: [] }])).toBeNull()
  })
})
