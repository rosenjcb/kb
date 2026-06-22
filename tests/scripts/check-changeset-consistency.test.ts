import { describe, expect, it } from 'vitest'
import { evaluateChangesetConsistency } from '../../scripts/check-changeset-consistency.mjs'

describe('evaluateChangesetConsistency', () => {
  it('passes when source changed with a pending changeset and no version bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.10.0',
    })
    expect(result.ok).toBe(true)
  })

  it('allows non-version package.json edits (deps/scripts) without a bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json', 'pnpm-lock.yaml', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.10.0',
    })
    expect(result.ok).toBe(true)
  })

  it('fails when source changed without a changeset', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts'],
      pendingChangesets: [],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.10.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('without a changeset'))).toBe(true)
  })

  it('fails when the version is bumped in a feature PR', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.11.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('Do not bump the package.json version'))).toBe(true)
  })

  it('fails when CHANGELOG.md is hand-edited in a feature PR', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'CHANGELOG.md', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.10.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('CHANGELOG.md'))).toBe(true)
  })

  it('passes for docs/config-only PRs with no changeset', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['README.md', 'docs/DEPLOY_CLOUD_RUN.md'],
      pendingChangesets: [],
      basePackageVersion: '0.10.0',
      headPackageVersion: '0.10.0',
    })
    expect(result.ok).toBe(true)
  })
})
