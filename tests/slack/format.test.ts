import { describe, expect, it } from 'vitest'
// @ts-expect-error — kb-slack ships plain ESM (.mjs) with no type declarations.
import { formatReply, stripMention } from '../../packages/kb-slack/src/format.mjs'

describe('stripMention', () => {
  it('strips the leading bot mention and trims', () => {
    expect(stripMention('<@U12345> how does auth work?')).toBe('how does auth work?')
  })

  it('strips multiple mentions and collapses whitespace', () => {
    expect(stripMention('<@U1>  hey   <@U2> ping')).toBe('hey ping')
  })

  it('returns empty string for empty input', () => {
    expect(stripMention('')).toBe('')
    expect(stripMention(undefined)).toBe('')
  })
})

describe('formatReply', () => {
  it('returns the answer with up to three source titles', () => {
    const reply = formatReply({
      answer: '  Auth uses JWTs.  ',
      results: [
        { title: 'Auth Overview' },
        { filePath: 'src/auth/jwt.ts' },
        { title: 'Sessions' },
        { title: 'Ignored fourth' },
      ],
    })
    expect(reply).toBe('Auth uses JWTs.\n\n*Sources*\n• Auth Overview\n• src/auth/jwt.ts\n• Sessions')
  })

  it('returns just the answer when there are no sources', () => {
    expect(formatReply({ answer: 'Just the answer.', results: [] })).toBe('Just the answer.')
  })

  it('falls back to a friendly miss when there is no answer', () => {
    expect(formatReply({ answer: null, results: [] })).toBe(
      "I couldn't find anything in the knowledge base for that."
    )
    expect(formatReply({})).toBe("I couldn't find anything in the knowledge base for that.")
  })
})
