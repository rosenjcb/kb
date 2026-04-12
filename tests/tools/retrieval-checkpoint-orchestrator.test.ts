import { describe, expect, it } from 'vitest'
import { buildCheckpointRecord, estimateConfidence } from '../../src/tools/retrieval-checkpoint-orchestrator'

describe('retrieval-checkpoint-orchestrator', () => {
  it('Given result counts, then estimateConfidence returns deterministic bands', () => {
    expect(estimateConfidence(0)).toBe(0)
    expect(estimateConfidence(1)).toBe(0.55)
    expect(estimateConfidence(2)).toBe(0.72)
    expect(estimateConfidence(3)).toBe(0.86)
  })

  it('Given high-confidence hybrid hit, then next action is return', () => {
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

  it('Given low-confidence lexical stage, then next action advances to rewrite retry', () => {
    const record = buildCheckpointRecord({
      stage: 'lexical_recovery',
      totalResults: 0,
      method: 'lexical-fallback',
      reason: 'lexical-stage-complete',
    })

    expect(record.status).toBe('miss')
    expect(record.nextAction).toBe('advance')
  })

  it('Given rewrite retry stage, then next action always returns', () => {
    const record = buildCheckpointRecord({
      stage: 'query_rewrite_retry',
      totalResults: 0,
      method: 'lexical-fallback',
      reason: 'keyword-broadened',
    })

    expect(record.nextAction).toBe('return')
  })
})
