import { describe, expect, it } from 'vitest'
import { evaluateChangesetConsistency } from '../../scripts/check-changeset-consistency.mjs'

describe('evaluateChangesetConsistency', () => {
  it('passes when source changed with full version bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json', 'CHANGELOG.md', 'research/version.tex'],
      pendingChangesets: [],
      basePackageVersion: '0.3.0',
      headPackageVersion: '0.4.0',
      headTexVersion: '0.4.0',
    })
    expect(result.ok).toBe(true)
  })

  it('fails when source changed without version bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts'],
      pendingChangesets: [],
      basePackageVersion: '0.3.0',
      headPackageVersion: '0.3.0',
      headTexVersion: '0.3.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('without a version bump'))).toBe(true)
  })

  it('fails when pending changeset files remain', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      basePackageVersion: '0.3.0',
      headPackageVersion: '0.3.0',
      headTexVersion: '0.3.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('Pending changeset'))).toBe(true)
  })

  it('fails on partial version bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['package.json', 'CHANGELOG.md'],
      pendingChangesets: [],
      basePackageVersion: '0.3.0',
      headPackageVersion: '0.4.0',
      headTexVersion: '0.3.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('Partial version bump'))).toBe(true)
  })

  it('fails when version.tex does not match package.json', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['package.json', 'CHANGELOG.md', 'research/version.tex'],
      pendingChangesets: [],
      basePackageVersion: '0.3.0',
      headPackageVersion: '0.4.0',
      headTexVersion: '0.3.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('does not match package.json'))).toBe(true)
  })
})
