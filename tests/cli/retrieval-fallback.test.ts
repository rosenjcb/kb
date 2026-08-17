import { describe, expect, it } from 'vitest'
import {
  TOP_SOURCE_PREVIEW_LIMIT,
  formatReadDocumentSourcesPreview,
} from '@kb/core/query/retrieval-fallback.js'

describe('retrieval-fallback sources preview', () => {
  it('[TC-J09B] Given more than TOP_SOURCE_PREVIEW_LIMIT files, then footer says top N of M', () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      metadata: { id: `fact-${index + 1}`, sourcePath: `src/f${index + 1}.ts` },
    }))

    const out = formatReadDocumentSourcesPreview(results)
    expect(out.startsWith(`top ${TOP_SOURCE_PREVIEW_LIMIT} of 25 file(s): `)).toBe(true)
    // Exactly TOP_SOURCE_PREVIEW_LIMIT files listed, first-ranked first.
    expect(out.split('; ')).toHaveLength(TOP_SOURCE_PREVIEW_LIMIT)
    expect(out).toContain('src/f1.ts')
  })

  it('[TC-XOR5] Given at most TOP_SOURCE_PREVIEW_LIMIT files, then footer says all M, folding symbols', () => {
    const results = [
      { metadata: { id: 'fact-a', sourcePath: 'src/a.ts', symbol: 'foo' } },
      { metadata: { id: 'fact-b', sourcePath: 'docs/b.md' } },
    ]

    expect(formatReadDocumentSourcesPreview(results)).toBe('all 2 file(s): src/a.ts (foo); docs/b.md')
  })

  it('[TC-5JE4] Given no openable hits, then footer is (none)', () => {
    expect(formatReadDocumentSourcesPreview([])).toBe('(none)')
    // Non-openable refs (fact:// fallback ids) are dropped, leaving nothing to cite.
    expect(
      formatReadDocumentSourcesPreview([{ metadata: { id: 'fact-x', filePath: 'fact://deadbeef' } }])
    ).toBe('(none)')
  })
})
