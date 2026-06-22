/**
 * Slack request signing verification (Events API).
 *
 * Slack signs every request: `v0=HMAC_SHA256(signingSecret, "v0:<timestamp>:<rawBody>")`,
 * sent in `X-Slack-Signature` with the unix `X-Slack-Request-Timestamp`. We recompute it
 * over the *raw* body and compare in constant time, rejecting stale timestamps to blunt
 * replay. Pure (no I/O) so it is unit-testable without a live Slack.
 *
 * Docs: https://api.slack.com/authentication/verifying-requests-from-slack
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Compute the `v0=…` signature for a raw request body. */
export function computeSignature(signingSecret, timestamp, rawBody) {
  const hmac = createHmac('sha256', signingSecret)
  hmac.update(`v0:${timestamp}:${rawBody}`)
  return `v0=${hmac.digest('hex')}`
}

/**
 * Validate a Slack request signature + freshness. Returns true only when the secret,
 * signature, and timestamp are present, the timestamp is within `maxSkewSeconds`, and the
 * recomputed signature matches in constant time.
 */
export function isValidSlackRequest({
  signingSecret,
  signature,
  timestamp,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = 60 * 5,
}) {
  if (!signingSecret || typeof signature !== 'string' || !signature) return false
  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(nowSeconds - ts) > maxSkewSeconds) return false

  const expected = Buffer.from(computeSignature(signingSecret, timestamp, rawBody))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
