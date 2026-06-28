import { describe, expect, it } from 'vitest'
import {
  SPINNER_MAX_LINE_LEN,
  SPINNER_MAX_LINES,
  truncateStatusLines,
} from '../../src/tui/components/LoadingSpinner'

describe('tui/LoadingSpinner — truncateStatusLines', () => {
  it('[TC-35] returns empty array for undefined', () => {
    expect(truncateStatusLines(undefined)).toEqual([])
  })

  it('[TC-36] returns empty array for empty string', () => {
    expect(truncateStatusLines('')).toEqual([])
  })

  it('[TC-37] returns empty array for whitespace-only string', () => {
    expect(truncateStatusLines('   \n   ')).toEqual([])
  })

  it('[TC-38] returns single non-empty line', () => {
    expect(truncateStatusLines('Loading...')).toEqual(['Loading...'])
  })

  it(`[TC-39] keeps at most ${SPINNER_MAX_LINES} lines (tail)`, () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`)
    const result = truncateStatusLines(lines.join('\n'))
    expect(result).toHaveLength(SPINNER_MAX_LINES)
    expect(result[0]).toBe(`Line ${10 - SPINNER_MAX_LINES + 1}`)
    expect(result[result.length - 1]).toBe('Line 10')
  })

  it(`[TC-40] truncates lines longer than ${SPINNER_MAX_LINE_LEN} chars with ellipsis`, () => {
    const long = 'A'.repeat(SPINNER_MAX_LINE_LEN + 20)
    const result = truncateStatusLines(long)
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(SPINNER_MAX_LINE_LEN)
    expect(result[0].endsWith('…')).toBe(true)
  })

  it('[TC-41] does not truncate lines at exactly the limit', () => {
    const exact = 'B'.repeat(SPINNER_MAX_LINE_LEN)
    const result = truncateStatusLines(exact)
    expect(result[0]).toBe(exact)
    expect(result[0]).not.toContain('…')
  })

  it('[TC-42] filters blank lines', () => {
    const input = 'Line 1\n\n   \nLine 2'
    expect(truncateStatusLines(input)).toEqual(['Line 1', 'Line 2'])
  })

  it('[TC-43] trims trailing whitespace from lines', () => {
    const result = truncateStatusLines('hello   \nworld  ')
    expect(result).toEqual(['hello', 'world'])
  })

  it('[TC-44] respects custom maxLines and maxLineLen params', () => {
    const input = Array.from({ length: 5 }, (_, i) => `L${i + 1}`).join('\n')
    const result = truncateStatusLines(input, 2, 3)
    expect(result).toHaveLength(2)
    expect(result).toEqual(['L4', 'L5'])
  })

  it('[TC-45] a large streaming document only shows the tail — prevents scrollback overflow', () => {
    const doc = Array.from({ length: 200 }, (_, i) => `# Paragraph ${i + 1}`).join('\n')
    const result = truncateStatusLines(doc)
    expect(result.length).toBeLessThanOrEqual(SPINNER_MAX_LINES)
    expect(result[result.length - 1]).toBe('# Paragraph 200')
  })
})
