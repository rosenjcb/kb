import { resolveBootstrapPolicy, resolveSnapshotSource } from '@kb/server/server-bootstrap.js'
import { describe, expect, it } from 'vitest'

describe('resolveBootstrapPolicy', () => {
  it('defaults to auto when nothing is set', () => {
    expect(resolveBootstrapPolicy([], {})).toBe('auto')
  })

  it('reads the env var (case-insensitive)', () => {
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'snapshot-only' })).toBe(
      'snapshot-only'
    )
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'Snapshot-Only' })).toBe(
      'snapshot-only'
    )
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'AUTO' })).toBe('auto')
  })

  it('lets the flag win over the env', () => {
    expect(
      resolveBootstrapPolicy(['--bootstrap-policy', 'snapshot-only'], {
        KB_SERVER_BOOTSTRAP_POLICY: 'auto',
      })
    ).toBe('snapshot-only')
    expect(
      resolveBootstrapPolicy(['--bootstrap-policy', 'auto'], {
        KB_SERVER_BOOTSTRAP_POLICY: 'snapshot-only',
      })
    ).toBe('auto')
  })

  it('throws on an unrecognized value', () => {
    expect(() => resolveBootstrapPolicy(['--bootstrap-policy', 'nonsense'], {})).toThrow(
      /Invalid bootstrap policy/
    )
    expect(() => resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'lazy' })).toThrow(
      /Invalid bootstrap policy/
    )
  })
})

describe('resolveSnapshotSource', () => {
  it('returns undefined when neither flag nor env is set', () => {
    expect(resolveSnapshotSource([], {})).toBeUndefined()
    expect(resolveSnapshotSource([], { KB_SERVER_SNAPSHOT: '   ' })).toBeUndefined()
  })

  it('reads the env var', () => {
    expect(resolveSnapshotSource([], { KB_SERVER_SNAPSHOT: '/mnt/kb-state' })).toBe('/mnt/kb-state')
  })

  it('lets the --from flag win over the env', () => {
    expect(resolveSnapshotSource(['--from', '/mnt/flag'], { KB_SERVER_SNAPSHOT: '/mnt/env' })).toBe(
      '/mnt/flag'
    )
  })
})
