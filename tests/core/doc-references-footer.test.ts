import { describe, expect, it } from 'vitest'
import {
  appendReferencesFooter,
  renderReferencesFooter,
} from '../../src/core/doc-references-footer'

describe('renderReferencesFooter', () => {
  it('Given facts, then renders a References section with fact:// URIs', () => {
    const output = renderReferencesFooter([
      { id: 'fact-abc123', factText: 'Foo bars baz.' },
      { id: 'fact-def456', factText: 'Quux runs here.' },
    ])

    expect(output).toBe(
      '## References\n\n- Foo bars baz. — `fact://abc123`\n- Quux runs here. — `fact://def456`\n'
    )
  })

  it('Given empty facts array, then returns empty string (no orphan heading)', () => {
    expect(renderReferencesFooter([])).toBe('')
  })

  it('Given a fact id that is not prefixed, then formatFactUri returns the id unchanged', () => {
    expect(renderReferencesFooter([{ id: 'raw-id', factText: 'Plain.' }])).toContain(
      '`raw-id`'
    )
  })
})

describe('appendReferencesFooter', () => {
  it('Given a body and facts, then appends footer with blank line separation', () => {
    const result = appendReferencesFooter('# Title\n\nBody.\n', [
      { id: 'fact-1', factText: 'F.' },
    ])
    expect(result).toBe('# Title\n\nBody.\n\n## References\n\n- F. — `fact://1`\n')
  })

  it('Given body without trailing newline and facts, then still separates cleanly', () => {
    const result = appendReferencesFooter('Body without newline', [
      { id: 'fact-1', factText: 'F.' },
    ])
    expect(result).toBe('Body without newline\n\n## References\n\n- F. — `fact://1`\n')
  })

  it('Given no facts, then returns body with trailing newline ensured', () => {
    expect(appendReferencesFooter('Body.', [])).toBe('Body.\n')
    expect(appendReferencesFooter('Body.\n', [])).toBe('Body.\n')
  })
})
