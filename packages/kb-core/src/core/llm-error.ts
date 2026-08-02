/**
 * Structured LLM transport errors.
 *
 * Providers used to throw bare `Error`s with the HTTP status baked into the
 * message string, which left callers with nothing to branch on: a 429 from a
 * spent credit balance and a model returning prose were indistinguishable. The
 * query/chat paths then swallowed both, so an outage surfaced to the caller as
 * a confident "no answer" instead of "the provider rejected the call".
 *
 * {@link LLMApiError} carries the provider, HTTP status, and a coarse
 * {@link LLMErrorKind} so every layer above can decide whether to retry, fail
 * loudly, or degrade — and so the reason reaches the user verbatim.
 */

/** Coarse failure classes. Enough to decide retry/report; not a full taxonomy. */
export type LLMErrorKind =
  | 'rate_limit'
  | 'insufficient_credits'
  | 'auth'
  | 'invalid_request'
  | 'context_length'
  | 'server'
  | 'timeout'
  | 'network'
  | 'empty_response'
  | 'unknown'

/** Kinds worth retrying — transient capacity/transport problems, not policy. */
const RETRYABLE_KINDS: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  'rate_limit',
  'server',
  'timeout',
  'network',
])

/**
 * Kinds an operator must act on — the call will keep failing until someone
 * changes billing, keys, or quota. Callers use this to escalate rather than
 * quietly degrade.
 */
const OPERATOR_ACTION_KINDS: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  'insufficient_credits',
  'auth',
])

export function isRetryableLLMErrorKind(kind: LLMErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind)
}

export function needsOperatorAction(kind: LLMErrorKind): boolean {
  return OPERATOR_ACTION_KINDS.has(kind)
}

/** A structured, already-classified failure from an LLM provider call. */
export class LLMApiError extends Error {
  readonly name = 'LLMApiError'
  readonly provider: string
  readonly kind: LLMErrorKind
  readonly status?: number
  /** Raw provider error text, before it was wrapped for display. */
  readonly detail?: string
  /** Original thrown value. Declared here because the repo targets ES2020, which predates `Error.cause`. */
  readonly cause?: unknown

  constructor(input: {
    provider: string
    kind: LLMErrorKind
    message: string
    status?: number
    detail?: string
    cause?: unknown
  }) {
    super(input.message)
    this.provider = input.provider
    this.kind = input.kind
    if (input.status !== undefined) this.status = input.status
    if (input.detail !== undefined) this.detail = input.detail
    if (input.cause !== undefined) this.cause = input.cause
  }

  get retryable(): boolean {
    return isRetryableLLMErrorKind(this.kind)
  }
}

/**
 * Map an HTTP status + provider message to a {@link LLMErrorKind}.
 *
 * Credit exhaustion is the case this exists for and it is not uniform across
 * providers: Anthropic returns 400 with `credit balance is too low`, OpenAI
 * returns 429 with `insufficient_quota`, others use 402. Status alone would
 * file the first as a bad request and the second as a rate limit, so the
 * message is checked before falling back to the status.
 */
export function classifyProviderStatus(status: number, message: string): LLMErrorKind {
  const text = message.toLowerCase()

  if (
    text.includes('credit balance') ||
    text.includes('insufficient_quota') ||
    text.includes('insufficient quota') ||
    text.includes('insufficient credits') ||
    text.includes('billing') ||
    text.includes('payment required') ||
    text.includes('exceeded your current quota')
  ) {
    return 'insufficient_credits'
  }
  if (
    text.includes('context length') ||
    text.includes('context_length') ||
    text.includes('too many tokens')
  ) {
    return 'context_length'
  }

  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'insufficient_credits'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status === 400 || status === 404 || status === 422) return 'invalid_request'
  return 'unknown'
}

/** `[anthropic] API request failed (429): rate limited` → provider + status. */
const LEGACY_MESSAGE_RE = /^\[([^\]]+)\]\s*API request failed\s*\((\d{3})\)\s*:\s*([\s\S]*)$/

/**
 * Normalize anything thrown on an LLM call path into an {@link LLMApiError}.
 *
 * Accepts an already-structured `LLMApiError` (returned unchanged), a legacy
 * `[provider] API request failed (NNN): …` string error (re-parsed so errors
 * thrown before this module existed still classify), an `AbortError`/timeout,
 * a `fetch` `TypeError`, or anything else (→ `unknown`).
 */
export function toLLMApiError(error: unknown, fallbackProvider = 'llm'): LLMApiError {
  if (error instanceof LLMApiError) return error

  const raw = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''

  const legacy = LEGACY_MESSAGE_RE.exec(raw)
  if (legacy) {
    const [, provider = fallbackProvider, statusText = '', detail = ''] = legacy
    const status = Number.parseInt(statusText, 10)
    return new LLMApiError({
      provider,
      kind: classifyProviderStatus(status, detail),
      message: raw,
      status,
      detail,
      cause: error,
    })
  }

  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(raw)) {
    return new LLMApiError({
      provider: fallbackProvider,
      kind: 'timeout',
      message: raw || 'LLM call timed out',
      cause: error,
    })
  }

  // Undici/fetch transport failures surface as a TypeError with this shape.
  if (name === 'TypeError' && /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(raw)) {
    return new LLMApiError({
      provider: fallbackProvider,
      kind: 'network',
      message: raw,
      cause: error,
    })
  }

  return new LLMApiError({
    provider: fallbackProvider,
    kind: 'unknown',
    message: raw || 'Unknown LLM error',
    cause: error,
  })
}

/** Wire/telemetry shape for a failed stage. Safe to serialize to any client. */
export interface LLMFailure {
  /** Pipeline stage that failed, e.g. `synthesis`, `chat-synthesis`. */
  stage: string
  kind: LLMErrorKind
  /** Human-readable reason, shown verbatim to operators and agents. */
  message: string
  provider?: string
  status?: number
  retryable: boolean
}

export function toLLMFailure(stage: string, error: unknown, fallbackProvider?: string): LLMFailure {
  const apiError = toLLMApiError(error, fallbackProvider)
  return {
    stage,
    kind: apiError.kind,
    message: apiError.message,
    ...(apiError.provider ? { provider: apiError.provider } : {}),
    ...(apiError.status !== undefined ? { status: apiError.status } : {}),
    retryable: apiError.retryable,
  }
}

/** A failure the model itself caused by returning nothing usable — not transport. */
export function emptyResponseFailure(stage: string, provider?: string): LLMFailure {
  return {
    stage,
    kind: 'empty_response',
    message: 'The model returned an empty response.',
    ...(provider ? { provider } : {}),
    retryable: true,
  }
}

/** One-line rendering for CLI/TUI and MCP notes. */
export function describeLLMFailure(failure: LLMFailure): string {
  const where = failure.provider ? ` from ${failure.provider}` : ''
  const action = needsOperatorAction(failure.kind)
    ? ' Check the provider API key and billing status.'
    : failure.retryable
      ? ' This is usually transient — retry shortly.'
      : ''
  return `Answer synthesis failed (${failure.kind})${where}: ${failure.message}.${action}`.replace(
    /\.\.$/,
    '.'
  )
}
