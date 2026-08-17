import { describe, expect, it } from 'vitest'
import { buildCheckpointRecord } from '@kb/core/tools/retrieval-checkpoint-orchestrator.js'
import { assessResultCount } from '@kb/core/core/evidence-label.js'

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
})
