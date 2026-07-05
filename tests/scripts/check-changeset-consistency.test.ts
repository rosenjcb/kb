import { describe, expect, it } from 'vitest'
import {
  evaluateChangesetConsistency,
  evaluateStagedChangesetGuard,
  isSingleSemverStep,
} from '../../scripts/check-changeset-consistency.mjs'

const NO_BUMP = { base: '0.10.0', head: '0.10.0' }
const BUMPED = { base: '0.10.0', head: '0.11.0' }
const DOUBLE_BUMP = { base: '0.10.0', head: '0.12.0' }

const ALL_NO_BUMP = { kbClient: NO_BUMP, kbCore: NO_BUMP, kbServer: NO_BUMP }

describe('evaluateChangesetConsistency', () => {
  it('[TC-1] passes when kb-client source is bumped and no changeset remains', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts', 'packages/kb-client/CHANGELOG.md'],
      pendingChangesets: [],
      kbClient: BUMPED,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-2] fails when kb-client source changed but the version was not bumped', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      ...ALL_NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(e => e.includes('@kb/client source changed but its version was not bumped'))
    ).toBe(true)
  })

  it('[TC-3] fails when a pending changeset has not been applied', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: ['.changeset/foo.md'],
      kbClient: BUMPED,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('not applied'))).toBe(true)
  })

  it('[TC-4] requires only the affected package to bump (kb-server untouched)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: BUMPED,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-5] fails when kb-server source changed without a kb-server bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-server/Dockerfile'],
      pendingChangesets: [],
      ...ALL_NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(e => e.includes('@kb/server source changed but its version was not bumped'))
    ).toBe(true)
  })

  it('[TC-6] allows kb-client and kb-server to bump independently in one PR', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts', 'packages/kb-server/Dockerfile'],
      pendingChangesets: [],
      kbClient: { base: '0.10.0', head: '0.11.0' },
      kbCore: NO_BUMP,
      kbServer: { base: '0.10.0', head: '0.10.1' },
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-7] passes for docs/config-only PRs with no bump', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['docs/skill-system.md', '.changeset/README.md'],
      pendingChangesets: [],
      ...ALL_NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-8] passes when only http test-collection files change under packages/kb-server', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-server/http/server.http'],
      pendingChangesets: [],
      ...ALL_NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-9] fails when more than one changeset is pending', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: ['.changeset/foo.md', '.changeset/bar.md'],
      kbClient: BUMPED,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('at most one changeset'))).toBe(true)
  })

  it('[TC-10] fails when the version jumped more than one step', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: DOUBLE_BUMP,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('jumped more than one semver step'))).toBe(true)
  })

  it('[TC-11] passes for a patch bump (exactly one step)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '0.10.1', head: '0.10.2' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-12] passes for a major bump (exactly one step)', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '0.11.3', head: '1.0.0' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-13] fails when minor bumped but patch not reset', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '0.10.1', head: '0.11.1' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('jumped more than one semver step'))).toBe(true)
  })

  it('[TC-13b] fails when the version was downgraded', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '1.2.1', head: '1.2.0' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('did not move forward'))).toBe(true)
  })

  it('[TC-14] requires kb-core bump when core source changes', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-core/src/service/kb-service.ts'],
      pendingChangesets: [],
      kbClient: NO_BUMP,
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(e => e.includes('@kb/core source changed but its version was not bumped'))
    ).toBe(true)
  })

  it('[TC-15] accepts a brand-new package with no base version on main', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-core/src/service/kb-service.ts'],
      pendingChangesets: [],
      kbClient: NO_BUMP,
      kbCore: { base: null, head: '1.1.0' },
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
    expect(result.notes.some(n => n.includes('@kb/core introduced at 1.1.0'))).toBe(true)
  })

  it('[TC-16] fails when version jumps multiple steps from pre-1.0 to stable', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '0.21.0', head: '1.1.1' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('jumped more than one semver step'))).toBe(true)
  })

  it('[TC-16b] passes for a single major step from pre-1.0', () => {
    const result = evaluateChangesetConsistency({
      changedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClient: { base: '0.21.0', head: '1.0.0' },
      kbCore: NO_BUMP,
      kbServer: NO_BUMP,
    })
    expect(result.ok).toBe(true)
  })
})

describe('isSingleSemverStep', () => {
  it('[TC-17] accepts patch, minor, and major single steps', () => {
    expect(isSingleSemverStep('1.0.0', '1.0.1')).toBe(true)
    expect(isSingleSemverStep('1.0.0', '1.1.0')).toBe(true)
    expect(isSingleSemverStep('1.0.0', '2.0.0')).toBe(true)
  })

  it('[TC-18] rejects double jumps and invalid minor forms', () => {
    expect(isSingleSemverStep('1.0.0', '1.2.0')).toBe(false)
    expect(isSingleSemverStep('1.1.4', '1.3.0')).toBe(false)
    expect(isSingleSemverStep('0.10.1', '0.11.1')).toBe(false)
  })
})

describe('evaluateStagedChangesetGuard', () => {
  it('[TC-19] passes when shipped source is staged with a pending changeset', () => {
    const result = evaluateStagedChangesetGuard({
      stagedFiles: ['packages/kb-client/src/cli/index.ts', '.changeset/foo.md'],
      pendingChangesets: ['.changeset/foo.md'],
      kbClientHead: '1.0.0',
      kbClientStaged: '1.0.0',
      kbCoreHead: '1.0.0',
      kbCoreStaged: '1.0.0',
      kbServerHead: '1.0.0',
      kbServerStaged: '1.0.0',
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-20] fails when shipped source is staged without changeset or bump', () => {
    const result = evaluateStagedChangesetGuard({
      stagedFiles: ['packages/kb-client/src/cli/index.ts'],
      pendingChangesets: [],
      kbClientHead: '1.0.0',
      kbClientStaged: '1.0.0',
      kbClientBase: '1.0.0',
      kbCoreHead: '1.0.0',
      kbCoreStaged: '1.0.0',
      kbCoreBase: '1.0.0',
      kbServerHead: '1.0.0',
      kbServerStaged: '1.0.0',
      kbServerBase: '1.0.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('no changeset is pending'))).toBe(true)
  })

  it('[TC-21] passes when staged package.json carries a valid single-step bump', () => {
    const result = evaluateStagedChangesetGuard({
      stagedFiles: ['packages/kb-client/src/cli/index.ts', 'packages/kb-client/package.json'],
      pendingChangesets: [],
      kbClientHead: '1.0.0',
      kbClientStaged: '1.1.0',
      kbCoreHead: '1.0.0',
      kbCoreStaged: '1.0.0',
      kbServerHead: '1.0.0',
      kbServerStaged: '1.0.0',
    })
    expect(result.ok).toBe(true)
  })

  it('[TC-22] fails when staged bump jumps more than one step', () => {
    const result = evaluateStagedChangesetGuard({
      stagedFiles: ['packages/kb-client/src/cli/index.ts', 'packages/kb-client/package.json'],
      pendingChangesets: [],
      kbClientHead: '1.1.4',
      kbClientStaged: '1.3.0',
      kbCoreHead: '1.0.0',
      kbCoreStaged: '1.0.0',
      kbServerHead: '1.0.0',
      kbServerStaged: '1.0.0',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('exactly one semver step'))).toBe(true)
  })
})
