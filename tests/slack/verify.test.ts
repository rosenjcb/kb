import { describe, expect, it } from 'vitest'
// @ts-expect-error — kb-slack ships plain ESM (.mjs) with no type declarations.
import { computeSignature, isValidSlackRequest } from '../../packages/kb-slack/src/verify.mjs'

const SECRET = 'top-secret-signing-key'
const BODY = '{"type":"event_callback","event":{"type":"app_mention"}}'

function sign(timestamp: string, body: string, secret = SECRET): string {
  return computeSignature(secret, timestamp, body)
}

describe('isValidSlackRequest', () => {
  const now = 1_700_000_000

  it('accepts a correctly signed, fresh request', () => {
    const ts = String(now)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: sign(ts, BODY),
        timestamp: ts,
        rawBody: BODY,
        nowSeconds: now,
      })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const ts = String(now)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: sign(ts, BODY),
        timestamp: ts,
        rawBody: `${BODY} `,
        nowSeconds: now,
      })
    ).toBe(false)
  })

  it('rejects a wrong signing secret', () => {
    const ts = String(now)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: sign(ts, BODY, 'other-secret'),
        timestamp: ts,
        rawBody: BODY,
        nowSeconds: now,
      })
    ).toBe(false)
  })

  it('rejects a stale timestamp (replay guard)', () => {
    const ts = String(now - 60 * 10)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: sign(ts, BODY),
        timestamp: ts,
        rawBody: BODY,
        nowSeconds: now,
      })
    ).toBe(false)
  })

  it('rejects missing signature or timestamp', () => {
    const ts = String(now)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: undefined,
        timestamp: ts,
        rawBody: BODY,
        nowSeconds: now,
      })
    ).toBe(false)
    expect(
      isValidSlackRequest({
        signingSecret: SECRET,
        signature: sign(ts, BODY),
        timestamp: 'not-a-number',
        rawBody: BODY,
        nowSeconds: now,
      })
    ).toBe(false)
  })
})
