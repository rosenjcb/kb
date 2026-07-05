import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { readClientVersion, readServerVersion } from '../scripts/release-package.mjs'

describe('release-package', () => {
  it('[TC-535] readClientVersion matches packages/kb-client/package.json', () => {
    const version = JSON.parse(readFileSync('packages/kb-client/package.json', 'utf-8')).version
    expect(readClientVersion()).toBe(version)
  })

  it('[TC-536] readServerVersion matches packages/kb-server/package.json', () => {
    const version = JSON.parse(readFileSync('packages/kb-server/package.json', 'utf-8')).version
    expect(readServerVersion()).toBe(version)
  })
})
