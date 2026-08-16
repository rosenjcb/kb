import {
  clientSupportsFormElicitation,
  feedbackElicitationMessage,
  parseElicitedHelped,
  truncateForElicit,
} from '@kb/server/mcp-feedback-elicitation.js'
import { isMcpElicitationEnvEnabled } from '@kb/server/mcp-server.js'
import { createServerElicitFeedback } from '@kb/server/mcp-tools.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { describe, expect, it, vi } from 'vitest'

function makeFakeServer(opts: {
  capabilities?: { form?: object; url?: object }
  elicitInput?: (params: unknown) => Promise<unknown>
  request?: (req: unknown, schema: unknown) => Promise<unknown>
}): Server {
  return {
    getClientCapabilities: () =>
      opts.capabilities ? { elicitation: opts.capabilities } : undefined,
    elicitInput: opts.elicitInput ?? vi.fn(),
    request: opts.request ?? vi.fn(),
  } as unknown as Server
}

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

  it('[TC-W21K] KB_MCP_ELICITATION defaults to true; only false opts out', () => {
    expect(isMcpElicitationEnvEnabled(undefined)).toBe(true)
    expect(isMcpElicitationEnvEnabled('')).toBe(true)
    expect(isMcpElicitationEnvEnabled('true')).toBe(true)
    expect(isMcpElicitationEnvEnabled('false')).toBe(false)
  })
})

describe('createServerElicitFeedback', () => {
  const ctx = { query: 'how does auth work?', answer: 'Via loginHandler.', requestId: 'req-1' }

  it('[TC-S6SI] resolves unavailable without asking when no elicitation capability is declared', async () => {
    const elicitInput = vi.fn()
    const request = vi.fn()
    const server = makeFakeServer({ capabilities: undefined, elicitInput, request })
    const elicitFeedback = createServerElicitFeedback(server)
    await expect(elicitFeedback(ctx)).resolves.toEqual({ kind: 'unavailable' })
    expect(elicitInput).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('[TC-MGIV] resolves unavailable without asking when the client only declares url-mode', async () => {
    const elicitInput = vi.fn()
    const request = vi.fn()
    const server = makeFakeServer({ capabilities: { url: {} }, elicitInput, request })
    const elicitFeedback = createServerElicitFeedback(server)
    await expect(elicitFeedback(ctx)).resolves.toEqual({ kind: 'unavailable' })
    expect(elicitInput).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('[TC-8HEN] dispatches via the raw request() fallback for back-compat empty elicitation: {}', async () => {
    const elicitInput = vi.fn()
    const request = vi.fn(async () => ({ action: 'decline' }))
    const server = makeFakeServer({ capabilities: {}, elicitInput, request })
    const elicitFeedback = createServerElicitFeedback(server)
    await elicitFeedback(ctx)
    expect(request).toHaveBeenCalledTimes(1)
    expect(elicitInput).not.toHaveBeenCalled()
    const [req] = request.mock.calls[0]
    expect(req).toMatchObject({ method: 'elicitation/create' })
  })

  it('[TC-BY0W] dispatches via elicitInput() when the client declares explicit form support', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'decline' }))
    const request = vi.fn()
    const server = makeFakeServer({ capabilities: { form: {} }, elicitInput, request })
    const elicitFeedback = createServerElicitFeedback(server)
    await elicitFeedback(ctx)
    expect(elicitInput).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    const [params] = elicitInput.mock.calls[0]
    expect(params).toMatchObject({ mode: 'form', requestedSchema: expect.any(Object) })
  })

  it('[TC-6RV1] accept with a valid helped value resolves accepted with helped/notes', async () => {
    const server = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => ({
        action: 'accept',
        content: { helped: 'partial', notes: 'missed a case' },
      }),
    })
    const elicitFeedback = createServerElicitFeedback(server)
    await expect(elicitFeedback(ctx)).resolves.toEqual({
      kind: 'accepted',
      helped: 'partial',
      notes: 'missed a case',
    })
  })

  it('[TC-EYUX] accept with a missing or invalid helped value resolves unavailable', async () => {
    const missing = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => ({ action: 'accept', content: {} }),
    })
    await expect(createServerElicitFeedback(missing)(ctx)).resolves.toEqual({ kind: 'unavailable' })

    const invalid = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => ({ action: 'accept', content: { helped: 'kinda' } }),
    })
    await expect(createServerElicitFeedback(invalid)(ctx)).resolves.toEqual({ kind: 'unavailable' })
  })

  it('[TC-CXZ2] decline resolves dismissed with action decline', async () => {
    const server = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => ({ action: 'decline' }),
    })
    await expect(createServerElicitFeedback(server)(ctx)).resolves.toEqual({
      kind: 'dismissed',
      action: 'decline',
    })
  })

  it('[TC-AFVZ] cancel resolves dismissed with action cancel', async () => {
    const server = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => ({ action: 'cancel' }),
    })
    await expect(createServerElicitFeedback(server)(ctx)).resolves.toEqual({
      kind: 'dismissed',
      action: 'cancel',
    })
  })

  it('[TC-U3IC] a rejecting client request resolves unavailable instead of throwing', async () => {
    const server = makeFakeServer({
      capabilities: { form: {} },
      elicitInput: async () => {
        throw new Error('client disconnected')
      },
    })
    await expect(createServerElicitFeedback(server)(ctx)).resolves.toEqual({ kind: 'unavailable' })
  })
})
