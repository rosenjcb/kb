import { describe, expect, it, vi } from 'vitest'
import { QueryTraceSnapshotStore } from '@kb/server/query-trace-snapshot-store.js'
import type { QueryFeedbackTrace } from '@kb/server/query-feedback-store.js'

function trace(over: Partial<QueryFeedbackTrace> = {}): QueryFeedbackTrace {
  return { sourceCount: 3, sourcePaths: ['a.ts'], noteCount: 1, ...over }
}

describe('QueryTraceSnapshotStore', () => {
  it('[TC-QTS1] Given a recorded requestId, then the snapshot comes back with its trace', () => {
    const s = new QueryTraceSnapshotStore()
    s.record('req-1', 'eval-kb', trace({ sourceCount: 7 }))
    const got = s.get('req-1')
    expect(got?.requestId).toBe('req-1')
    expect(got?.base).toBe('eval-kb')
    expect(got?.trace.sourceCount).toBe(7)
  })

  it('[TC-QTS2] Given an unknown requestId, then it returns undefined rather than throwing', () => {
    const s = new QueryTraceSnapshotStore()
    expect(() => s.get('never-seen')).not.toThrow()
    expect(s.get('never-seen')).toBeUndefined()
  })

  it('[TC-QTS3] Given no base, then the field is omitted rather than stored as undefined', () => {
    const s = new QueryTraceSnapshotStore()
    s.record('req-2', undefined, trace())
    expect(s.get('req-2')).not.toHaveProperty('base')
  })

  it('[TC-QTS4] Given a re-recorded requestId, then the later snapshot wins', () => {
    const s = new QueryTraceSnapshotStore()
    s.record('req-3', 'a', trace({ sourceCount: 1 }))
    s.record('req-3', 'b', trace({ sourceCount: 2 }))
    expect(s.get('req-3')?.trace.sourceCount).toBe(2)
    expect(s.get('req-3')?.base).toBe('b')
  })

  it('[TC-QTS5] Given more than the cap, then the oldest entries are evicted and recent ones survive', () => {
    const s = new QueryTraceSnapshotStore()
    for (let i = 0; i < 250; i++) s.record(`req-${i}`, 'b', trace())
    expect(s.get('req-0')).toBeUndefined()
    expect(s.get('req-249')).toBeDefined()
  })

  it('[TC-QTS6] Given an entry older than the TTL, then it is pruned on the next access', () => {
    vi.useFakeTimers()
    try {
      const s = new QueryTraceSnapshotStore()
      s.record('req-old', 'b', trace())
      expect(s.get('req-old')).toBeDefined()
      vi.advanceTimersByTime(7 * 60 * 60 * 1000) // past the 6h TTL
      expect(s.get('req-old')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('[TC-QTS7] Given an optional grounding field, then it round-trips onto the snapshot', () => {
    const s = new QueryTraceSnapshotStore()
    s.record('req-4', 'b', trace({ unsupportedClaims: 2, hadUngroundedFiles: true }))
    const got = s.get('req-4')
    expect(got?.trace.unsupportedClaims).toBe(2)
    expect(got?.trace.hadUngroundedFiles).toBe(true)
  })
})
