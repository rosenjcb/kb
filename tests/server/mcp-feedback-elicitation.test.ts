import { describe, expect, it } from 'vitest'
import {
  clientSupportsFormElicitation,
  feedbackElicitationMessage,
  parseElicitedHelped,
  truncateForElicit,
} from '@kb/server/mcp-feedback-elicitation.js'

describe('mcp-feedback-elicitation helpers', () => {
  it('treats empty elicitation capability as form mode (spec back-compat)', () => {
    expect(clientSupportsFormElicitation(undefined)).toBe(false)
    expect(clientSupportsFormElicitation({})).toBe(true)
    expect(clientSupportsFormElicitation({ form: {} })).toBe(true)
    expect(clientSupportsFormElicitation({ url: {} })).toBe(false)
    expect(clientSupportsFormElicitation({ form: {}, url: {} })).toBe(true)
  })

  it('builds a message that includes query, answer preview, and requestId', () => {
    const message = feedbackElicitationMessage({
      query: 'how does auth work?',
      answer: 'Via loginHandler.',
      requestId: 'req-9',
    })
    expect(message).toContain('how does auth work?')
    expect(message).toContain('Via loginHandler.')
    expect(message).toContain('req-9')
    expect(message).toContain('Did it help?')
  })

  it('truncates long answers for the elicitation preview', () => {
    expect(truncateForElicit('x'.repeat(10), 10)).toBe('x'.repeat(10))
    expect(truncateForElicit('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('parses helped enum values only', () => {
    expect(parseElicitedHelped('yes')).toBe('yes')
    expect(parseElicitedHelped('partial')).toBe('partial')
    expect(parseElicitedHelped('no')).toBe('no')
    expect(parseElicitedHelped('kinda')).toBeUndefined()
    expect(parseElicitedHelped(1)).toBeUndefined()
  })
})
