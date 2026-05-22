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

  it('loading entry in the middle stays in liveItems while surrounding statics go to staticItems', () => {
    // Simulates: meta(static) → answer(loading) → sep(static) → timing(static)
    // The answer must stay in liveItems until finalized; meta/sep/timing go to staticItems.
    // Ink's <Static> requires new items to be appended at the tail of staticItems.
    // App.tsx's write() calls finalizeChatResponse() before adding meta entries so the
    // answer is always committed before the entries that follow it.
    const entries: HistoryEntry[] = [
      { id: 'stage', type: 'chat-meta', content: 'stage> answer:done 300ms' },
      { id: 'answer', type: 'chat-assistant', content: 'The answer text', loading: true },
      { id: 'sep', type: 'chat-meta', content: 'sep> —' },
      { id: 'timing', type: 'chat-meta', content: 'timing> total=300ms' },
    ]

    const { staticItems, liveItems } = partitionHistoryEntries(entries)

    expect(liveItems).toEqual([
      { id: 'answer', type: 'chat-assistant', content: 'The answer text', loading: true },
    ])
    // stage, sep, timing are static; answer is still live
    expect(staticItems.map(e => e.id)).toEqual(['stage', 'sep', 'timing'])
  })

  it('once answer is committed it appears in staticItems at its array position', () => {
    // After finalizeChatResponse() the answer becomes loading: false.
    // Because App.tsx flushes the answer before adding sep/timing, the committed
    // answer lands before them in the entries array — so Static sees them in order.
    const entries: HistoryEntry[] = [
      { id: 'stage', type: 'chat-meta', content: 'stage> answer:done 300ms' },
      { id: 'answer', type: 'chat-assistant', content: 'The answer text' }, // loading: false
      { id: 'sep', type: 'chat-meta', content: 'sep> —' },
      { id: 'timing', type: 'chat-meta', content: 'timing> total=300ms' },
    ]

    const { staticItems, liveItems } = partitionHistoryEntries(entries)

    expect(liveItems).toEqual([])
    expect(staticItems.map(e => e.id)).toEqual(['stage', 'answer', 'sep', 'timing'])
  })
})
