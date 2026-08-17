import { describe, expect, it } from 'vitest'
import { buildCheckpointRecord } from '@kb/core/tools/retrieval-checkpoint-orchestrator.js'
import { assessResultCount, isEvidenceAtLeast } from '@kb/core/core/evidence-label.js'

describe('retrieval-checkpoint-orchestrator', () => {
  it('[TC-EJGF] Given result counts, then assessResultCount returns deterministic labels', () => {
    expect(assessResultCount(0)).toBe('none')
    expect(assessResultCount(1)).toBe('weak')
    expect(assessResultCount(2)).toBe('moderate')
    expect(assessResultCount(3)).toBe('strong')
  })

  it('[TC-44OK] Given a strong hybrid hit, then next action is return', () => {
    const record = buildCheckpointRecord({
      stage: 'hybrid_primary',
      totalResults: 3,
      method: 'hybrid',
      reason: 'hybrid-stage-complete',
      detail: 'fts+vector-rerank',
    })

    expect(record.status).toBe('hit')
    expect(record.nextAction).toBe('return')
  })

  it('[TC-WYD7] Given a lexical stage with no evidence, then next action advances to rewrite retry', () => {
    const record = buildCheckpointRecord({
      stage: 'lexical_recovery',
      totalResults: 0,
      method: 'lexical-fallback',
      reason: 'lexical-stage-complete',
    })

    expect(record.status).toBe('miss')
    expect(record.nextAction).toBe('advance')
  })

  it('[TC-QVTW] Given rewrite retry stage, then next action always returns', () => {
    const record = buildCheckpointRecord({
      stage: 'query_rewrite_retry',
      totalResults: 0,
      method: 'lexical-fallback',
      reason: 'keyword-broadened',
    })

    expect(record.nextAction).toBe('return')
  })

  it('[TC-EV19] Given the same result count, then low top-relevance scores below high top-relevance', () => {
    // #219: three results are no longer unconditionally `strong`. With relevance wired in,
    // three low-cosine results must land below three high-cosine ones — the exact case that was
    // impossible to construct while the label was a bare `assessResultCount`.
    const strong = buildCheckpointRecord({
      stage: 'hybrid_primary',
      totalResults: 3,
      method: 'hybrid',
      reason: 'hybrid-stage-complete',
      avgTop: 0.9,
      conceptCoverage: 0.9,
    })
    const weak = buildCheckpointRecord({
      stage: 'hybrid_primary',
      totalResults: 3,
      method: 'hybrid',
      reason: 'hybrid-stage-complete',
      avgTop: 0.1,
      conceptCoverage: 0.1,
    })

    // Bare count would call both 'strong'; relevance-aware labelling separates them.
    expect(assessResultCount(3)).toBe('strong')
    expect(strong.evidence).toBe('strong')
    expect(isEvidenceAtLeast(strong.evidence, weak.evidence)).toBe(true)
    expect(isEvidenceAtLeast(weak.evidence, strong.evidence)).toBe(false)
    expect(strong.nextAction).toBe('return')
  })

  it('[TC-EV20] Given no measured relevance, then it falls back to the count heuristic', () => {
    // No `avgTop` (e.g. no embedder) must preserve the legacy count behavior, not force 'none'.
    const record = buildCheckpointRecord({
      stage: 'hybrid_primary',
      totalResults: 3,
      method: 'hybrid',
      reason: 'hybrid-stage-complete',
    })
    expect(record.evidence).toBe('strong')
  })
})
