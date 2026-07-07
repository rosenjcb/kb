import { describe, expect, it } from 'vitest'
import { resolveBootstrapPolicy } from '@kb/server/server-bootstrap.js'

describe('resolveBootstrapPolicy', () => {
  it('defaults to auto when nothing is set', () => {
    expect(resolveBootstrapPolicy([], {})).toBe('auto')
  })

  it('reads the env var (case-insensitive)', () => {
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'prepared-only' })).toBe('prepared-only')
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'Prepared-Only' })).toBe('prepared-only')
    expect(resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'AUTO' })).toBe('auto')
  })

  it('lets the flag win over the env', () => {
    expect(
      resolveBootstrapPolicy(['--bootstrap-policy', 'prepared-only'], { KB_SERVER_BOOTSTRAP_POLICY: 'auto' })
    ).toBe('prepared-only')
    expect(
      resolveBootstrapPolicy(['--bootstrap-policy', 'auto'], { KB_SERVER_BOOTSTRAP_POLICY: 'prepared-only' })
    ).toBe('auto')
  })

  it('throws on an unrecognized value', () => {
    expect(() => resolveBootstrapPolicy(['--bootstrap-policy', 'nonsense'], {})).toThrow(/Invalid bootstrap policy/)
    expect(() => resolveBootstrapPolicy([], { KB_SERVER_BOOTSTRAP_POLICY: 'lazy' })).toThrow(/Invalid bootstrap policy/)
  })
})
