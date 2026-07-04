/**
 * Shared query HTTP timeout for kb-client and kb-server.
 *
 * `KB_QUERY_TIMEOUT` accepts a duration (`60s`, `2m`, `90000`) or bare milliseconds.
 * Default: 60s.
 */

const DEFAULT_QUERY_TIMEOUT_MS = 60_000

/** Parse `KB_QUERY_TIMEOUT`; returns `undefined` when the value is malformed. */
export function parseQueryTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_QUERY_TIMEOUT_MS
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return DEFAULT_QUERY_TIMEOUT_MS

  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!match) return undefined
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined

  switch (match[2]) {
    case 'ms':
      return Math.round(amount)
    case 's':
      return Math.round(amount * 1000)
    case 'm':
      return Math.round(amount * 60 * 1000)
    case 'h':
      return Math.round(amount * 60 * 60 * 1000)
    default:
      return Math.round(amount)
  }
}

/** Resolve the effective query timeout, throwing on invalid env. */
export function resolveQueryTimeoutMs(value: string | undefined = process.env.KB_QUERY_TIMEOUT): number {
  const parsed = parseQueryTimeoutMs(value)
  if (parsed === undefined) {
    throw new Error(`Invalid KB_QUERY_TIMEOUT: ${value}`)
  }
  return parsed
}
