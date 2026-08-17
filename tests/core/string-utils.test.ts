import { describe, expect, it } from 'vitest'
import { basenameTitle, titleFromFilePath, toTitleCase } from '@kb/core/core/string-utils.js'

describe('toTitleCase', () => {
  it('[TC-AZWV] lowercases and title-cases a normal word', () => {
    expect(toTitleCase('hello')).toBe('Hello')
  })

  it('[TC-21QQ] title-cases multiple words', () => {
    expect(toTitleCase('hello world')).toBe('Hello World')
  })

  it('[TC-27BH] converts ALL_CAPS to Title Case', () => {
    expect(toTitleCase('AGENTS')).toBe('Agents')
  })

  it('[TC-2VO8] converts SCREAMING_SNAKE_CASE to Title Case', () => {
    expect(toTitleCase('AGENT_LOOP')).toBe('Agent Loop')
  })

  it('[TC-HGMQ] converts kebab-case to Title Case', () => {
    expect(toTitleCase('my-test-doc')).toBe('My Test Doc')
  })

  it('[TC-LBPH] strips file extension before casing', () => {
    expect(toTitleCase('CLAUDE.md')).toBe('Claude')
  })

  it('[TC-RY82] trims leading and trailing whitespace', () => {
    expect(toTitleCase('  hello  ')).toBe('Hello')
  })

  it('[TC-C5XY] handles mixed separators', () => {
    expect(toTitleCase('some_kebab-and_snake')).toBe('Some Kebab And Snake')
  })
})

describe('basenameTitle', () => {
  it('[TC-0DCP] returns the filename for a simple path', () => {
    expect(basenameTitle('CLAUDE.md')).toBe('CLAUDE.md')
  })

  it('[TC-TDA7] strips directory components from a nested path', () => {
    expect(basenameTitle('src/core/AGENT_LOOP.md')).toBe('AGENT_LOOP.md')
  })

  it('[TC-RO9F] preserves original casing — does NOT title-case', () => {
    expect(basenameTitle('EVALUATION.md')).toBe('EVALUATION.md')
    expect(basenameTitle('readme.md')).toBe('readme.md')
  })

  it('[TC-01AZ] handles Windows-style backslash separators', () => {
    expect(basenameTitle('src\\core\\TUI.md')).toBe('TUI.md')
  })

  it('[TC-0SAT] returns the input unchanged when there is no path separator', () => {
    expect(basenameTitle('README.md')).toBe('README.md')
  })
})

describe('titleFromFilePath', () => {
  it('[TC-JBOZ] converts a path-style title to Cap Every Word', () => {
    expect(titleFromFilePath('src/core/AGENT_LOOP.md')).toBe('Agent Loop')
  })

  it('[TC-LBP9] converts a simple filename to Title Case', () => {
    expect(titleFromFilePath('CLAUDE.md')).toBe('Claude')
  })

  it('[TC-KABW] converts kebab-cased filename to Title Case', () => {
    expect(titleFromFilePath('my-document.ts')).toBe('My Document')
  })

  it('[TC-68YF] strips extension before casing', () => {
    expect(titleFromFilePath('TESTING.md')).toBe('Testing')
  })
})
