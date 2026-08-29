import { describe, expect, it } from 'vitest'
import { splitMarkdownSections } from '@kb/core/core/markdown-sections.js'

/** Body long enough to clear MIN_SECTION_CHARS (200) so it stands as its own section. */
function long(word: string, n = 60): string {
  return `${word} `.repeat(n).trim()
}

describe('splitMarkdownSections', () => {
  it('[TC-MDS1] Given an empty or whitespace-only body, then it returns no sections', () => {
    expect(splitMarkdownSections('')).toEqual([])
    expect(splitMarkdownSections('   \n\n  ')).toEqual([])
  })

  it('[TC-MDS2] Given a document with no headings, then it indexes as a single section rather than disappearing', () => {
    const out = splitMarkdownSections(long('prose'))
    expect(out).toHaveLength(1)
    expect(out[0].heading).toBe('')
    expect(out[0].text).toContain('prose')
  })

  it('[TC-MDS3] Given sibling headings, then each becomes its own section carrying its own heading', () => {
    const body = ['## Alpha', long('alpha'), '', '## Beta', long('beta')].join('\n')
    const out = splitMarkdownSections(body)
    expect(out).toHaveLength(2)
    expect(out[0].heading).toBe('Alpha')
    expect(out[1].heading).toBe('Beta')
    expect(out[0].text).not.toContain('beta ')
  })

  it('[TC-MDS4] Given a nested heading, then the heading trail carries its ancestors so the section stays findable by their terms', () => {
    const body = ['# Configuration', long('intro'), '', '## Environment variables', long('envvars')].join('\n')
    const out = splitMarkdownSections(body)
    const nested = out.find(s => s.heading.includes('Environment variables'))
    expect(nested).toBeDefined()
    expect(nested?.heading).toBe('Configuration > Environment variables')
  })

  it('[TC-MDS5] Given a `#` line inside a fenced code block, then it is not treated as a heading', () => {
    const body = ['## Real', long('real'), '', '```bash', '# not a heading', 'echo hi', '```', long('more')].join('\n')
    const out = splitMarkdownSections(body)
    expect(out.every(s => !s.heading.includes('not a heading'))).toBe(true)
  })

  it('[TC-MDS6] Given a section below the minimum size, then it merges forward instead of fragmenting the signal', () => {
    const body = ['## Tiny', 'one line', '', '## Substantial', long('body')].join('\n')
    const out = splitMarkdownSections(body)
    // The stub is absorbed rather than standing alone as its own retrieval unit.
    expect(out).toHaveLength(1)
    expect(out[0].text).toContain('one line')
    expect(out[0].text).toContain('body')
  })

  it('[TC-MDS7] Given a section far over the size ceiling, then it splits on paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${long('filler', 30)}`)
    const body = ['## Huge', ...paragraphs].join('\n\n')
    const out = splitMarkdownSections(body)
    expect(out.length).toBeGreaterThan(1)
    // Every split keeps the parent heading, so citations still resolve to the same document.
    expect(out.every(s => s.heading === 'Huge')).toBe(true)
    // Splitting happens between paragraphs, never mid-paragraph.
    expect(out.every(s => !/Paragraph \d+ filler filler$/.test(s.text.split('\n\n')[0] ?? ''))).toBe(true)
  })

  it('[TC-MDS8] Given content before the first heading, then the preamble is kept with an empty heading', () => {
    const body = [long('preamble'), '', '## Later', long('later')].join('\n')
    const out = splitMarkdownSections(body)
    expect(out[0].heading).toBe('')
    expect(out[0].text).toContain('preamble')
  })
})
