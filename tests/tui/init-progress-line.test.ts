import { describe, expect, it } from 'vitest'
import { parseInitProgressLine } from '../../src/tui/init-progress-line'

describe('parseInitProgressLine', () => {
  it('[TC-28] extracts repo slug and progress body', () => {
    expect(
      parseInitProgressLine('[init] @ raysan5-raylib │ [====] 1/6 code-index tree-sitter 10/20')
    ).toEqual({
      repo: 'raysan5-raylib',
      body: '[====] 1/6 code-index tree-sitter 10/20',
    })
  })

  it('[TC-29] returns the full line when no repo prefix is present', () => {
    expect(parseInitProgressLine('[init] [====] 1/6 code-index')).toEqual({
      body: '[init] [====] 1/6 code-index',
    })
  })

  it('[TC-30] passes through init prompts unchanged', () => {
    const prompt = '> Git URL(s)'
    expect(parseInitProgressLine(prompt)).toEqual({ body: prompt })
  })
})
