import { describe, expect, it } from 'vitest'
import { parseInitOutput } from '../../src/tui/init-status.js'

describe('init status helpers', () => {
  it('routes init progress lines away from transcript history', () => {
    const parsed = parseInitOutput(`
Initializing KB — press Enter to skip any question.
[init] [====--------------------] 5/9 pass2 follow-up + refining docs…
`)

    expect(parsed.historyLines).toEqual(['Initializing KB — press Enter to skip any question.'])
    expect(parsed.progressLine).toBe(
      '[init] [====--------------------] 5/9 pass2 follow-up + refining docs…'
    )
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
[init] [===---------------------] 2/9 scan-facts indexing source sentences into facts…
[init] [======------------------] 4/9 pass1 drafting docs + coverage…
`)

    expect(parsed.historyLines).toEqual([])
    expect(parsed.progressLine).toBe(
      '[init] [======------------------] 4/9 pass1 drafting docs + coverage…'
    )
  })
})
