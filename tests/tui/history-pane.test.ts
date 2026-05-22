import { describe, expect, it } from 'vitest'
import { partitionHistoryEntries } from '../../src/tui/components/HistoryPane.js'
import type { HistoryEntry } from '../../src/tui/types.js'

describe('partitionHistoryEntries', () => {
  it('keeps completed rows in static and loading rows live', () => {
    const entries: HistoryEntry[] = [
      { id: 'a', type: 'chat-you', content: 'hello' },
      { id: 'b', type: 'result', content: 'partial…', loading: true },
      { id: 'c', type: 'chat-meta', content: 'retrieval> …' },
    ]

    expect(partitionHistoryEntries(entries)).toEqual({
      staticItems: [
        { id: 'a', type: 'chat-you', content: 'hello' },
        { id: 'c', type: 'chat-meta', content: 'retrieval> …' },
      ],
      liveItems: [{ id: 'b', type: 'result', content: 'partial…', loading: true }],
    })
  })

  it('returns empty liveItems when nothing is loading', () => {
    const entries: HistoryEntry[] = [{ id: 'done', type: 'result', content: 'full doc body' }]

    expect(partitionHistoryEntries(entries)).toEqual({
      staticItems: entries,
      liveItems: [],
    })
  })
})
