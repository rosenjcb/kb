import { describe, expect, it } from 'vitest'
import { evaluateChangesetConsistency } from '../../scripts/check-changeset-consistency.mjs'

const NO_BUMP = { base: '0.10.0', head: '0.10.0' }
const BUMPED = { base: '0.10.0', head: '0.11.0' }
const DOUBLE_BUMP = { base: '0.10.0', head: '0.12.0' }

describe('evaluateChangesetConsistency', () => {
  it('[TC-1] passes when kb source is bumped and no changeset remains', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'CHANGELOG.md', 'package.json'],
      pendingChangesets: [],
      kb: BUMPED,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-2] fails when kb source changed but the version was not bumped', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts'],
      pendingChangesets: [],
      kb: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('kb source changed but its version was not bumped'))).toBe(
      true
    )
  })

  it('[TC-3] fails when a pending changeset has not been applied', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: ['.changeset/foo.md'],
      kb: BUMPED,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('not applied'))).toBe(true)
  })

  it('[TC-4] requires only the affected package to bump (kb-server untouched)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: [],
      kb: BUMPED,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-5] fails when kb-server source changed without a kb-server bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-server/Dockerfile'],
      pendingChangesets: [],
      kb: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(e => e.includes('kb-server source changed but its version was not bumped'))
    ).toBe(true)
  })

  it('[TC-6] allows kb and kb-server to bump independently in one PR', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/server/server-cli.ts', 'packages/kb-server/Dockerfile'],
      pendingChangesets: [],
      kb: { base: '0.10.0', head: '0.11.0' },
      kbServer: { base: '0.10.0', head: '0.10.1' },
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-7] passes for docs/config-only PRs with no bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['docs/skill-system.md', '.changeset/README.md'],
      pendingChangesets: [],
      kb: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-8] passes when only http test-collection files change under packages/kb-server', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-server/http/server.http'],
      pendingChangesets: [],
      kb: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-9] fails when more than one changeset is pending', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: ['.changeset/foo.md', '.changeset/bar.md'],
      kb: BUMPED,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('at most one changeset'))).toBe(true)
  })

  it('[TC-10] fails when the version jumped more than one step', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: [],
      kb: DOUBLE_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('jumped more than one step'))).toBe(true)
  })

  it('[TC-11] passes for a patch bump (exactly one step)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: [],
      kb: { base: '0.10.1', head: '0.10.2' },
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-12] passes for a major bump (exactly one step)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: [],
      kb: { base: '0.11.3', head: '1.0.0' },
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-13] fails when minor bumped but patch not reset', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['src/cli/index.ts', 'package.json'],
      pendingChangesets: [],
      kb: { base: '0.10.1', head: '0.11.1' },
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('jumped more than one step'))).toBe(true)
  })
})
