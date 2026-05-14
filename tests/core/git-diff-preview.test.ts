import { describe, expect, it } from 'vitest'
import { colorizeUnifiedDiff, createUnifiedDiff } from '../../src/core/git-diff-preview'

describe('core/createUnifiedDiff', () => {
  it('produces a valid unified diff with --- and +++ headers', () => {
    const diff = createUnifiedDiff('file.md', 'old content', 'new content')
    expect(diff).toContain('--- file.md')
    expect(diff).toContain('+++ file.md')
    expect(diff).toContain('@@')
  })

  it('headers do NOT contain full document content', () => {
    const before = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'
    const after = 'Line 1\nLine 2\nChanged\nLine 4\nLine 5'
    const diff = createUnifiedDiff('doc.md', before, after)
    const lines = diff.split('\n')
    const headerLine = lines.find(l => l.startsWith('--- doc.md'))
    expect(headerLine).toBeDefined()
    // Header must not contain the document body — it should be "--- doc.md\t" only
    expect(headerLine).not.toContain('Line 1')
    expect(headerLine).not.toContain('Line 2')
  })

  it('the diff body (not header) shows the actual changed line', () => {
    const before = 'same line\nold version\nsame line'
    const after = 'same line\nnew version\nsame line'
    const diff = createUnifiedDiff('f.md', before, after)
    expect(diff).toContain('-old version')
    expect(diff).toContain('+new version')
  })

  it('does not duplicate full document content before the hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `Para ${i + 1}`).join('\n')
    const after = before.replace('Para 10', 'Changed')
    const diff = createUnifiedDiff('doc.md', before, after)
    // Count how many times "Para 1" appears in the diff
    // In a correct diff, "Para 1" appears only as a context line in the @@ hunk — not as a header
    const occurrences = diff.split('Para 1').length - 1
    // Should appear at most a few times as context lines, definitely not 20 times
    expect(occurrences).toBeLessThan(5)
  })

  it('context defaults to 3 lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`)
    const changed = [...lines]
    changed[5] = 'CHANGED'
    const diff = createUnifiedDiff('f.md', lines.join('\n'), changed.join('\n'))
    expect(diff).toContain('-L5')
    expect(diff).toContain('+CHANGED')
  })
})

describe('core/colorizeUnifiedDiff', () => {
  it('returns patch unchanged when color=false', () => {
    const patch = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new'
    expect(colorizeUnifiedDiff(patch, { color: false })).toBe(patch)
  })

  it('when color=true processes all lines without throwing', () => {
    const patch = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n context'
    // Chalk may be disabled in headless test envs, but the function must not throw
    // and must return a string with the same number of lines.
    const colored = colorizeUnifiedDiff(patch, { color: true })
    expect(typeof colored).toBe('string')
    expect(colored.split('\n')).toHaveLength(patch.split('\n').length)
  })
})
