import { describe, expect, it } from 'vitest'
import { ensureScanBaseArg } from '../../src/tui/init-args'

describe('ensureScanBaseArg', () => {
  it('Given scan args without --base and fallback exists, then appends --base fallback', () => {
    const result = ensureScanBaseArg([], 'dogfood')
    expect(result).toEqual(['--base', 'dogfood'])
  })

  it('Given --base already provided, then preserves original args', () => {
    const result = ensureScanBaseArg(['--base', 'custom'], 'dogfood')
    expect(result).toEqual(['--base', 'custom'])
  })

  it('Given empty fallback and no --base, then leaves args unchanged', () => {
    const result = ensureScanBaseArg([], '')
    expect(result).toEqual([])
  })
})
