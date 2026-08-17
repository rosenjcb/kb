import { describe, expect, it } from 'vitest'
import {
  LLMApiError,
  classifyProviderStatus,
  describeLLMFailure,
  emptyResponseFailure,
  isRetryableLLMErrorKind,
  needsOperatorAction,
  toLLMApiError,
  toLLMFailure,
} from '@kb/core/core/llm-error.js'

describe('classifyProviderStatus', () => {
  it('[TC-W9L2] Given a spent credit balance, when the status is any code, then it classifies as insufficient_credits', () => {
    // Anthropic reports this as 400, OpenAI as 429 — status alone would file the first as a
    // bad request and the second as a rate limit, so the message has to win.
    expect(classifyProviderStatus(400, 'Your credit balance is too low to access the API')).toBe(
      'insufficient_credits'
    )
    expect(
      classifyProviderStatus(429, 'You exceeded your current quota (insufficient_quota)')
    ).toBe('insufficient_credits')
    expect(classifyProviderStatus(402, 'payment required')).toBe('insufficient_credits')
  })

  it('[TC-5R2T] Given transport statuses, when classified, then each maps to its kind and retryability', () => {
    expect(classifyProviderStatus(429, 'rate limited')).toBe('rate_limit')
    expect(classifyProviderStatus(401, 'invalid x-api-key')).toBe('auth')
    expect(classifyProviderStatus(403, 'forbidden')).toBe('auth')
    expect(classifyProviderStatus(500, 'internal')).toBe('server')
    expect(classifyProviderStatus(503, 'overloaded')).toBe('server')

    expect(isRetryableLLMErrorKind('rate_limit')).toBe(true)
    expect(isRetryableLLMErrorKind('server')).toBe(true)
    expect(isRetryableLLMErrorKind('auth')).toBe(false)
    expect(isRetryableLLMErrorKind('insufficient_credits')).toBe(false)

    expect(needsOperatorAction('insufficient_credits')).toBe(true)
    expect(needsOperatorAction('auth')).toBe(true)
    expect(needsOperatorAction('rate_limit')).toBe(false)
  })
})

describe('toLLMApiError', () => {
  it('[TC-DI64] Given a legacy "[provider] API request failed (NNN)" error, then provider and status are recovered', () => {
    // Errors thrown before the structured class existed must still classify, or the
    // surfacing depends on every throw site having been migrated.
    const err = toLLMApiError(
      new Error('[anthropic] API request failed (429): rate limit exceeded')
    )
    expect(err).toBeInstanceOf(LLMApiError)
    expect(err.provider).toBe('anthropic')
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rate_limit')
    expect(err.retryable).toBe(true)
  })

  it('[TC-22WZ] Given an abort or fetch failure, then it classifies as timeout or network', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(toLLMApiError(abort).kind).toBe('timeout')

    const netErr = new TypeError('fetch failed')
    expect(toLLMApiError(netErr).kind).toBe('network')
  })

  it('[TC-8GII] Given an already-structured LLMApiError, then it passes through unchanged', () => {
    const original = new LLMApiError({
      provider: 'openai',
      kind: 'auth',
      message: 'bad key',
      status: 401,
    })
    expect(toLLMApiError(original)).toBe(original)
  })
})

describe('failure records', () => {
  it('[TC-CNLV] Given a thrown provider error, when converted to a failure, then the stage and reason survive', () => {
    const failure = toLLMFailure(
      'synthesis',
      new Error('[anthropic] API request failed (400): Your credit balance is too low'),
      'anthropic'
    )
    expect(failure.stage).toBe('synthesis')
    expect(failure.kind).toBe('insufficient_credits')
    expect(failure.retryable).toBe(false)
    expect(failure.provider).toBe('anthropic')

    const described = describeLLMFailure(failure)
    expect(described).toContain('insufficient_credits')
    expect(described).toContain('credit balance')
    // An operator-action failure has to say what the operator should go do.
    expect(described).toContain('billing')

    const empty = emptyResponseFailure('synthesis', 'anthropic')
    expect(empty.kind).toBe('empty_response')
    expect(empty.retryable).toBe(true)
  })
})
