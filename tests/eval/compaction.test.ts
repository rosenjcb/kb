import { describe, expect, it } from 'vitest'
import {
  buildEmptyCompactionRecord,
  type CompactionEvent,
  type CompactionRecord,
} from '../../eval/compaction'

describe('buildEmptyCompactionRecord', () => {
  it('returns triggered: false', () => {
    expect(buildEmptyCompactionRecord().triggered).toBe(false)
  })

  it('returns an empty events array', () => {
    expect(buildEmptyCompactionRecord().events).toEqual([])
  })

  it('returns a new object each call (not shared reference)', () => {
    const a = buildEmptyCompactionRecord()
    const b = buildEmptyCompactionRecord()
    a.events.push({ stepIndex: 1, tokensFreed: 100, turnsCompacted: 3, condition: 'K' })
    expect(b.events).toHaveLength(0)
  })

  it('returned object satisfies CompactionRecord type shape', () => {
    const rec: CompactionRecord = buildEmptyCompactionRecord()
    expect(typeof rec.triggered).toBe('boolean')
    expect(Array.isArray(rec.events)).toBe(true)
  })
})

describe('CompactionEvent', () => {
  it('accepts all valid condition values', () => {
    const conditions = ['N', 'K', 'O'] as const
    for (const condition of conditions) {
      const event: CompactionEvent = {
        stepIndex: 0,
        tokensFreed: 500,
        turnsCompacted: 2,
        condition,
      }
      expect(event.condition).toBe(condition)
    }
  })
})
