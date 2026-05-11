import { describe, expect, it } from 'vitest'
import { parseInitOutput } from '../../src/tui/init-status.js'

describe('init status helpers', () => {
  it('routes init progress lines away from transcript history', () => {
    const parsed = parseInitOutput(`
Starting init…
[init] [==========--------------] 5/6 write …
`)

    expect(parsed.historyLines).toEqual(['Starting init…'])
    expect(parsed.progressLine).toBe('[init] [==========--------------] 5/6 write …')
  })

  it('keeps kb init questions in the main transcript history', () => {
    const parsed = parseInitOutput(`
[kb init] Follow-up questions for weak topics:
> What should a newcomer understand first about the project purpose or audience?
`)

    expect(parsed.historyLines).toEqual([
      '[kb init] Follow-up questions for weak topics:',
      '> What should a newcomer understand first about the project purpose or audience?',
    ])
    expect(parsed.progressLine).toBeUndefined()
  })

  it('uses the last init progress line when multiple updates arrive together', () => {
    const parsed = parseInitOutput(`
[init] [========----------------] 2/6 markdown-facts indexing source sentences into facts…
[init] [========----------------] 4/6 import-docs importing original markdown…
`)

    expect(parsed.historyLines).toEqual([])
    expect(parsed.progressLine).toBe(
      '[init] [========----------------] 4/6 import-docs importing original markdown…'
    )
  })

  it('keeps graph extraction totals inside the progress line without requiring a separate action row', () => {
    const parsed = parseInitOutput(`
[init] [====================----] 5/6 pass-graph files 10/79 (+5), +8 nodes, +14 connections | totals: 83 nodes, 141 connections
`)

    expect(parsed.historyLines).toEqual([])
    expect(parsed.progressLine).toBe(
      '[init] [====================----] 5/6 pass-graph files 10/79 (+5), +8 nodes, +14 connections | totals: 83 nodes, 141 connections'
    )
    expect(parsed.actionLine).toBeUndefined()
  })
})
