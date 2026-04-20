import { describe, expect, it } from 'vitest'
import { renderDiffBundle, renderNewFileDiff, renderTextDiff } from '../../src/core/git-diff-preview'

describe('git-diff-preview', () => {
  it('renders a new file diff section', () => {
    const diff = renderNewFileDiff('docs/new.md', '# Title\n\nBody\n')
    expect(diff).toContain('new file mode 100644')
    expect(diff).toContain('+++ b/docs/new.md')
    expect(diff).toContain('+# Title')
  })

  it('renders a unified text diff section', () => {
    const diff = renderTextDiff('docs/existing.md', 'line one\nline two\n', 'line one\nline changed\n')
    expect(diff).toContain('--- a/docs/existing.md')
    expect(diff).toContain('+++ b/docs/existing.md')
    expect(diff).toContain('-line two')
    expect(diff).toContain('+line changed')
  })

  it('renders empty fallback message when no sections exist', () => {
    const output = renderDiffBundle([], '# Nothing to change')
    expect(output).toBe('# Nothing to change')
  })
})
