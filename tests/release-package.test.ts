import { describe, expect, it } from 'vitest'

import { readClientVersion, readServerVersion } from '../scripts/release-package.mjs'

describe('release-package', () => {
  it('[TC-535] readClientVersion matches packages/kb-client/package.json', () => {
    expect(readClientVersion()).toBe('1.2.0')
  })

  it('[TC-536] readServerVersion matches packages/kb-server/package.json', () => {
    expect(readServerVersion()).toBe('1.1.5')
  })
})
