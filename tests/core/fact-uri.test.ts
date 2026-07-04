import { describe, expect, it } from 'vitest'
import { formatFactUri } from '@kb/core/core/fact-uri.js'

describe('formatFactUri', () => {
  it('[TC-63] strips fact- prefix before scheme so sources line does not repeat fact', () => {
    expect(formatFactUri('fact-91cf8cf47a435545')).toBe('fact://91cf8cf47a435545')
  })

  it('[TC-64] passes through ids that are not fact-prefixed', () => {
    expect(formatFactUri('doc-abc')).toBe('doc-abc')
  })
})
