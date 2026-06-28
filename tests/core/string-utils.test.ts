import { describe, expect, it } from 'vitest'
import { basenameTitle, titleFromFilePath, toTitleCase } from '../../src/core/string-utils'

describe('toTitleCase', () => {
  it('[TC-132] lowercases and title-cases a normal word', () => {
    expect(toTitleCase('hello')).toBe('Hello')
  })

  it('[TC-133] title-cases multiple words', () => {
    expect(toTitleCase('hello world')).toBe('Hello World')
  })

  it('[TC-134] converts ALL_CAPS to Title Case', () => {
    expect(toTitleCase('AGENTS')).toBe('Agents')
  })

  it('[TC-135] converts SCREAMING_SNAKE_CASE to Title Case', () => {
    expect(toTitleCase('AGENT_LOOP')).toBe('Agent Loop')
  })

  it('[TC-136] converts kebab-case to Title Case', () => {
    expect(toTitleCase('my-test-doc')).toBe('My Test Doc')
  })

  it('[TC-137] strips file extension before casing', () => {
    expect(toTitleCase('CLAUDE.md')).toBe('Claude')
  })

  it('[TC-138] trims leading and trailing whitespace', () => {
    expect(toTitleCase('  hello  ')).toBe('Hello')
  })

  it('[TC-139] handles mixed separators', () => {
    expect(toTitleCase('some_kebab-and_snake')).toBe('Some Kebab And Snake')
  })
})

describe('basenameTitle', () => {
  it('[TC-140] returns the filename for a simple path', () => {
    expect(basenameTitle('CLAUDE.md')).toBe('CLAUDE.md')
  })

  it('[TC-141] strips directory components from a nested path', () => {
    expect(basenameTitle('src/core/AGENT_LOOP.md')).toBe('AGENT_LOOP.md')
  })

  it('[TC-142] preserves original casing — does NOT title-case', () => {
    expect(basenameTitle('EVALUATION.md')).toBe('EVALUATION.md')
    expect(basenameTitle('readme.md')).toBe('readme.md')
  })

  it('[TC-143] handles Windows-style backslash separators', () => {
    expect(basenameTitle('src\\core\\TUI.md')).toBe('TUI.md')
  })

  it('[TC-144] returns the input unchanged when there is no path separator', () => {
    expect(basenameTitle('README.md')).toBe('README.md')
  })
})

describe('titleFromFilePath', () => {
  it('[TC-145] converts a path-style title to Cap Every Word', () => {
    expect(titleFromFilePath('src/core/AGENT_LOOP.md')).toBe('Agent Loop')
  })

  it('[TC-146] converts a simple filename to Title Case', () => {
    expect(titleFromFilePath('CLAUDE.md')).toBe('Claude')
  })

  it('[TC-147] converts kebab-cased filename to Title Case', () => {
    expect(titleFromFilePath('my-document.ts')).toBe('My Document')
  })

  it('[TC-148] strips extension before casing', () => {
    expect(titleFromFilePath('TESTING.md')).toBe('Testing')
  })
})
