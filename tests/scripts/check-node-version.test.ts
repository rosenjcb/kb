import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  evaluateNodeVersion,
  formatNodeVersionError,
  parseMinEngine,
  runFromPackageJson,
  versionGte,
} from '../../scripts/check-node-version.mjs'

describe('parseMinEngine', () => {
  it('[TC-15] parses major-only specs', () => {
    expect(parseMinEngine('>=24')).toEqual([24, 0, 0])
  })

  it('[TC-16] parses major.minor.patch specs', () => {
    expect(parseMinEngine('>=24.15.0')).toEqual([24, 15, 0])
  })

  it('[TC-17] returns [0,0,0] for unrecognized specs', () => {
    expect(parseMinEngine('^24')).toEqual([0, 0, 0])
  })
})

describe('versionGte', () => {
  it('[TC-19] accepts equal versions', () => {
    expect(versionGte([24, 15, 0], [24, 15, 0])).toBe(true)
  })

  it('[TC-20] accepts newer major', () => {
    expect(versionGte([25, 0, 0], [24, 99, 99])).toBe(true)
  })

  it('[TC-21] accepts newer minor on same major', () => {
    expect(versionGte([24, 16, 0], [24, 15, 9])).toBe(true)
  })

  it('[TC-22] rejects older major', () => {
    expect(versionGte([22, 22, 2], [24, 0, 0])).toBe(false)
  })

  it('[TC-23] rejects older patch when major/minor match', () => {
    expect(versionGte([24, 15, 0], [24, 15, 1])).toBe(false)
  })
})

describe('evaluateNodeVersion', () => {
  it('[TC-24] passes when engines.node is absent', () => {
    expect(evaluateNodeVersion({ enginesNode: null, currentVersion: '22.0.0' })).toEqual({ ok: true })
  })

  it('[TC-25] passes when current version meets minimum', () => {
    expect(
      evaluateNodeVersion({ enginesNode: '>=24', currentVersion: '24.15.0', nvmrc: '24.15.0' })
    ).toEqual({ ok: true })
  })

  it('[TC-26] fails when current version is below minimum', () => {
    expect(
      evaluateNodeVersion({ enginesNode: '>=24', currentVersion: '22.22.2', nvmrc: '24.15.0' })
    ).toEqual({
      ok: false,
      spec: '>=24',
      currentVersion: '22.22.2',
      nvmrc: '24.15.0',
    })
  })
})

describe('formatNodeVersionError', () => {
  it('[TC-27] includes nvm/fnm hints when .nvmrc is present', () => {
    const msg = formatNodeVersionError({
      ok: false,
      spec: '>=24',
      currentVersion: '22.22.2',
      nvmrc: '24.15.0',
    })
    expect(msg).toContain('kb requires Node >=24 (current: v22.22.2).')
    expect(msg).toContain('pins 24.15.0 in .nvmrc')
    expect(msg).toContain('nvm install && nvm use')
    expect(msg).toContain('fnm install && fnm use')
  })

  it('[TC-28] falls back to generic install hint without .nvmrc', () => {
    const msg = formatNodeVersionError({
      ok: false,
      spec: '>=24',
      currentVersion: '22.0.0',
      nvmrc: null,
    })
    expect(msg).toContain('Install Node 24+ and retry.')
    expect(msg).not.toContain('nvm install')
  })
})

describe('runFromPackageJson', () => {
  it('[TC-29] returns 0 when package.json has no engines.node', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-node-ok-'))
    const pkg = path.join(dir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: 'tmp' }))
    expect(runFromPackageJson(pkg, path.join(dir, '.nvmrc'), process.versions.node)).toBe(0)
  })

  it('[TC-30] returns 0 when current version satisfies engines.node', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-node-pass-'))
    const pkg = path.join(dir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: 'tmp', engines: { node: '>=0' } }))
    expect(runFromPackageJson(pkg, path.join(dir, '.nvmrc'), process.versions.node)).toBe(0)
  })

  it('[TC-31] returns 1 and prints nvm hints when version is too old', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-node-fail-'))
    const pkg = path.join(dir, 'package.json')
    const nvmrc = path.join(dir, '.nvmrc')
    writeFileSync(pkg, JSON.stringify({ name: 'tmp', engines: { node: '>=99' } }))
    writeFileSync(nvmrc, '99.0.0\n')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(runFromPackageJson(pkg, nvmrc, process.versions.node)).toBe(1)
      expect(err.mock.calls.flat().join('\n')).toContain('kb requires Node >=99')
      expect(err.mock.calls.flat().join('\n')).toContain('nvm install && nvm use')
    } finally {
      err.mockRestore()
    }
  })
})
