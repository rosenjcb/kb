import { describe, expect, it } from 'vitest'
import {
  colorizeUnifiedDiff,
  createUnifiedDiff,
  renderDiffBundle,
  renderNewFileDiff,
  renderTextDiff,
} from '../../src/core/git-diff-preview'

describe('git-diff-preview', () => {
  it('renders a new file diff section', () => {
    const diff = renderNewFileDiff('docs/new.md', '# Title\n\nBody\n')
    expect(diff).toContain('Index: docs/new.md')
    expect(diff).toContain('+# Title')
    expect(diff).toContain('+Body')
  })

  it('renders a unified text diff section', () => {
    const diff = renderTextDiff(
      'docs/existing.md',
      'line one\nline two\n',
      'line one\nline changed\n'
    )
    expect(diff).toContain('Index: docs/existing.md')
    expect(diff).toContain('-line two')
    expect(diff).toContain('+line changed')
  })

  it('createUnifiedDiff matches structural hunks', () => {
    const patch = createUnifiedDiff('x.md', 'a\n', 'b\n')
    expect(patch).toContain('@@')
    expect(patch).toContain('-a')
    expect(patch).toContain('+b')
  })

  it('colorizeUnifiedDiff with color false preserves patch', () => {
    const patch = createUnifiedDiff('f.md', 'x', 'y')
    const plain = colorizeUnifiedDiff(patch, { color: false })
    expect(plain).toBe(patch)
    const colored = colorizeUnifiedDiff(patch, { color: true })
    expect(colored.length).toBeGreaterThanOrEqual(patch.length)
  })

  it('renders empty fallback message when no sections exist', () => {
    const output = renderDiffBundle([], '# Nothing to change')
    expect(output).toBe('# Nothing to change')
  })
})
