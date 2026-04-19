import { describe, expect, it } from 'vitest'
import { basenameTitle, titleFromFilePath, toTitleCase } from '../../src/core/string-utils'

describe('toTitleCase', () => {
  it('lowercases and title-cases a normal word', () => {
    expect(toTitleCase('hello')).toBe('Hello')
  })

  it('title-cases multiple words', () => {
    expect(toTitleCase('hello world')).toBe('Hello World')
  })

  it('converts ALL_CAPS to Title Case', () => {
    expect(toTitleCase('AGENTS')).toBe('Agents')
  })

  it('converts SCREAMING_SNAKE_CASE to Title Case', () => {
    expect(toTitleCase('AGENT_LOOP')).toBe('Agent Loop')
  })

  it('converts kebab-case to Title Case', () => {
    expect(toTitleCase('my-test-doc')).toBe('My Test Doc')
  })

  it('strips file extension before casing', () => {
    expect(toTitleCase('CLAUDE.md')).toBe('Claude')
  })

  it('trims leading and trailing whitespace', () => {
    expect(toTitleCase('  hello  ')).toBe('Hello')
  })

  it('handles mixed separators', () => {
    expect(toTitleCase('some_kebab-and_snake')).toBe('Some Kebab And Snake')
  })
})

describe('basenameTitle', () => {
  it('returns the filename for a simple path', () => {
    expect(basenameTitle('CLAUDE.md')).toBe('CLAUDE.md')
  })

  it('strips directory components from a nested path', () => {
    expect(basenameTitle('src/core/AGENT_LOOP.md')).toBe('AGENT_LOOP.md')
  })

  it('preserves original casing — does NOT title-case', () => {
    expect(basenameTitle('EVALUATION.md')).toBe('EVALUATION.md')
    expect(basenameTitle('readme.md')).toBe('readme.md')
  })

  it('handles Windows-style backslash separators', () => {
    expect(basenameTitle('src\\core\\TUI.md')).toBe('TUI.md')
  })

  it('returns the input unchanged when there is no path separator', () => {
    expect(basenameTitle('README.md')).toBe('README.md')
  })
})

describe('titleFromFilePath', () => {
  it('converts a path-style title to Cap Every Word', () => {
    expect(titleFromFilePath('src/core/AGENT_LOOP.md')).toBe('Agent Loop')
  })

  it('converts a simple filename to Title Case', () => {
    expect(titleFromFilePath('CLAUDE.md')).toBe('Claude')
  })

  it('converts kebab-cased filename to Title Case', () => {
    expect(titleFromFilePath('my-document.ts')).toBe('My Document')
  })

  it('strips extension before casing', () => {
    expect(titleFromFilePath('TESTING.md')).toBe('Testing')
  })
})
