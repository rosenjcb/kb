import { describe, expect, it } from 'vitest'
import {
  DocsGenerateError,
  isDocsGenerateJsonOutputArgs,
  parseDocsGenerateCommand,
} from '../../src/cli/docs-generate-cli'

describe('parseDocsGenerateCommand', () => {
  it('Given help flag, then throws exit 0', () => {
    try {
      parseDocsGenerateCommand(['--help'])
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DocsGenerateError)
      expect((e as DocsGenerateError).exitCode).toBe(0)
    }
  })

  it('Given start prompt and --type, then parses', () => {
    const parsed = parseDocsGenerateCommand(['my topic', '--type', 'howto', '--limit', '5'])
    expect(parsed).toEqual({
      mode: 'start',
      prompt: 'my topic',
      type: 'howto',
      factLimit: 5,
      outputFormat: 'human',
    })
  })

  it('Given --resume and --answer, then parses', () => {
    const parsed = parseDocsGenerateCommand([
      '--resume',
      'abc-123',
      '--answer',
      'hello',
      '--base',
      'dogfood',
    ])
    expect(parsed).toEqual({
      mode: 'resume',
      sessionId: 'abc-123',
      base: 'dogfood',
      action: 'answer',
      answer: 'hello',
      outputFormat: 'human',
    })
  })

  it('Given --resume and --accept, then parses', () => {
    expect(
      parseDocsGenerateCommand(['--resume', 'sid', '--accept', '--base', 'dogfood'])
    ).toEqual({
      mode: 'resume',
      sessionId: 'sid',
      base: 'dogfood',
      action: 'accept',
      outputFormat: 'human',
    })
  })

  it('Given --resume and --reject, then parses feedback', () => {
    expect(
      parseDocsGenerateCommand(['--resume', 'sid', '--reject', 'no dates', '--base', 'dogfood'])
    ).toEqual({
      mode: 'resume',
      sessionId: 'sid',
      base: 'dogfood',
      action: 'reject',
      rejectFeedback: 'no dates',
      outputFormat: 'human',
    })
  })

  it('Given --finalize and --accept with resume, then throws mutual exclusion', () => {
    expect(() =>
      parseDocsGenerateCommand(['--resume', 'x', '--finalize', '--accept'])
    ).toThrow(DocsGenerateError)
  })

  it('Given --resume without action, then throws', () => {
    expect(() => parseDocsGenerateCommand(['--resume', 'x'])).toThrow(DocsGenerateError)
  })

  it('Given --list, then parses', () => {
    expect(parseDocsGenerateCommand(['--list'])).toEqual({ mode: 'list', outputFormat: 'human' })
  })

  it('Given --show id, then parses', () => {
    expect(parseDocsGenerateCommand(['--show', 'sid'])).toEqual({
      mode: 'show',
      sessionId: 'sid',
      outputFormat: 'human',
    })
  })

  it('Given multiple positional tokens, then joins into prompt', () => {
    const parsed = parseDocsGenerateCommand(['one', 'two', 'three'])
    expect(parsed).toEqual({ mode: 'start', prompt: 'one two three', outputFormat: 'human' })
  })

  it('Given --output json, then parses outputFormat', () => {
    expect(parseDocsGenerateCommand(['x', '--output', 'json'])).toMatchObject({
      mode: 'start',
      prompt: 'x',
      outputFormat: 'json',
    })
  })

  it('isDocsGenerateJsonOutputArgs detects docs generate --output json', () => {
    expect(isDocsGenerateJsonOutputArgs(['docs', 'generate', 'p', '--output', 'json'])).toBe(true)
    expect(isDocsGenerateJsonOutputArgs(['docs', 'generate', '--output', 'human'])).toBe(false)
    expect(isDocsGenerateJsonOutputArgs(['query', 'x'])).toBe(false)
  })
})
