import { describe, expect, it } from 'vitest'
import { ensureInitBaseArg } from '../../src/tui/init-args'

describe('ensureInitBaseArg', () => {
  it('Given no --base and fallback exists, then appends --base fallback', () => {
    const result = ensureInitBaseArg(['--rescan'], 'dogfood')
    expect(result).toEqual(['--rescan', '--base', 'dogfood'])
  })

  it('Given --base already provided, then preserves original args', () => {
    const result = ensureInitBaseArg(['--rescan', '--base', 'custom'], 'dogfood')
    expect(result).toEqual(['--rescan', '--base', 'custom'])
  })

  it('Given empty fallback and no --base, then leaves args unchanged', () => {
    const result = ensureInitBaseArg(['--rescan'], '')
    expect(result).toEqual(['--rescan'])
  })
})
