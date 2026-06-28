import { describe, expect, it } from 'vitest'
import {
  buildEmptyCompactionRecord,
  type CompactionEvent,
  type CompactionRecord,
} from '../../eval/compaction'

describe('buildEmptyCompactionRecord', () => {
  it('[TC-8] returns triggered: false', () => {
    expect(buildEmptyCompactionRecord().triggered).toBe(false)
  })

  it('[TC-9] returns an empty events array', () => {
    expect(buildEmptyCompactionRecord().events).toEqual([])
  })

  it('[TC-10] returns a new object each call (not shared reference)', () => {
    const a = buildEmptyCompactionRecord()
    const b = buildEmptyCompactionRecord()
    a.events.push({ stepIndex: 1, tokensFreed: 100, turnsCompacted: 3, condition: 'K' })
    expect(b.events).toHaveLength(0)
  })

  it('[TC-11] returned object satisfies CompactionRecord type shape', () => {
    const rec: CompactionRecord = buildEmptyCompactionRecord()
    expect(typeof rec.triggered).toBe('boolean')
    expect(Array.isArray(rec.events)).toBe(true)
  })
})

describe('CompactionEvent', () => {
  it('[TC-12] accepts all valid condition values', () => {
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
