import { describe, expect, it } from 'vitest'
import {
  TOP_SOURCE_PREVIEW_LIMIT,
  formatReadDocumentSourceIds,
  formatReadDocumentSourcesPreview,
} from '@kb/core/query/retrieval-fallback.js'

describe('retrieval-fallback sources preview', () => {
  it('[TC-433] Given more than TOP_SOURCE_PREVIEW_LIMIT hits, then footer says top N of M ranked', () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      metadata: { id: `fact-${index + 1}` },
    }))

    expect(formatReadDocumentSourceIds(results)).toHaveLength(TOP_SOURCE_PREVIEW_LIMIT)
    expect(formatReadDocumentSourcesPreview(results)).toBe(
      `top ${TOP_SOURCE_PREVIEW_LIMIT} of 25 ranked: ${Array.from({ length: TOP_SOURCE_PREVIEW_LIMIT }, (_, i) => `fact://${i + 1}`).join('; ')}`
    )
  })

  it('[TC-434] Given at most TOP_SOURCE_PREVIEW_LIMIT hits, then footer says all M ranked', () => {
    const results = [
      { metadata: { id: 'cli-facts' } },
      { metadata: { id: 'fact-b' } },
    ]

    expect(formatReadDocumentSourcesPreview(results)).toBe(
      'all 2 ranked: cli-facts; fact://b'
    )
  })

  it('[TC-435] Given no hits, then footer is (none)', () => {
    expect(formatReadDocumentSourcesPreview([])).toBe('(none)')
  })
})
