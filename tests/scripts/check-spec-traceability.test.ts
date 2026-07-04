import { describe, expect, it } from 'vitest'
import {
  collectTcTagsForSpec,
  evaluateSpecTraceability,
  uncoveredTcRows,
} from '../../scripts/check-spec-traceability.mjs'

describe('check-spec-traceability', () => {
  it('[TC-30] Given FACT_CURATOR spec, then all TC rows are covered by tests', () => {
    const result = evaluateSpecTraceability({
      manifest: [{ spec: 'packages/kb-core/src/tools/FACT_CURATOR.spec.md', testGlobs: ['tests/tools/fact-curator.test.ts'] }],
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-31] Given a TC row with no matching test tag, then check fails', () => {
    expect(uncoveredTcRows(['TC-1', 'TC-2'], new Set(['TC-1']))).toEqual(['TC-2'])
  })

  it('[TC-32] Given tags from fact-curator tests, then TC-1 through TC-10 are present', () => {
    const tags = collectTcTagsForSpec({
      spec: 'packages/kb-core/src/tools/FACT_CURATOR.spec.md',
      testGlobs: ['tests/tools/fact-curator.test.ts'],
    })
    for (let i = 1; i <= 10; i++) {
      expect(tags.has(`TC-${i}`)).toBe(true)
    }
  })
})
