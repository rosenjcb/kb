import { describe, expect, it } from 'vitest'
import { ensureScanBaseArg } from '@kb/client/tui/init-args.js'

describe('ensureScanBaseArg', () => {
  it('[TC-25] Given scan args without --base and fallback exists, then appends --base fallback', () => {
    const result = ensureScanBaseArg([], 'dogfood')
    expect(result).toEqual(['--base', 'dogfood'])
  })

  it('[TC-26] Given --base already provided, then preserves original args', () => {
    const result = ensureScanBaseArg(['--base', 'custom'], 'dogfood')
    expect(result).toEqual(['--base', 'custom'])
  })

  it('[TC-27] Given empty fallback and no --base, then leaves args unchanged', () => {
    const result = ensureScanBaseArg([], '')
    expect(result).toEqual([])
  })
})
