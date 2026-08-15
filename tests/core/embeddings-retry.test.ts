import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiEmbedder } from '@kb/core/core/embeddings.js'

/**
 * The embedder must absorb transient provider errors (429 rate limits, 5xx, network blips)
 * with bounded backoff so a busy provider slows a run instead of crashing it — while still
 * failing fast once the retry budget is spent (no infinite loop on an exhausted quota).
 */
describe('GeminiEmbedder retry/backoff', () => {
  const realFetch = globalThis.fetch
  const realWarn = console.warn

  beforeEach(() => {
    // Keep backoffs near-instant so the test stays fast.
    process.env.KB_EMBED_MAX_BACKOFF_MS = '1'
    process.env.GEMINI_API_BASE_URL = 'https://example.test'
    console.warn = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    console.warn = realWarn
    process.env.KB_EMBED_MAX_RETRIES = undefined
    process.env.KB_EMBED_MAX_BACKOFF_MS = undefined
    process.env.GEMINI_API_BASE_URL = undefined
  })

  const okResponse = () =>
    new Response(JSON.stringify({ embeddings: [{ values: [3, 4] }] }), { status: 200 })

  it('[TC-EMB-1] retries a 429 and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const embedder = new GeminiEmbedder('test-key', 'gemini-embedding-001', 2)
    const [vec] = await embedder.embed(['hello'])

    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 3-4-5 normalized to unit length.
    expect(vec[0]).toBeCloseTo(0.6)
    expect(vec[1]).toBeCloseTo(0.8)
  })

  it('[TC-EMB-2] gives up after the retry budget and throws', async () => {
    process.env.KB_EMBED_MAX_RETRIES = '2'
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const embedder = new GeminiEmbedder('test-key', 'gemini-embedding-001', 2)
    await expect(embedder.embed(['hello'])).rejects.toThrow(/429/)
    // Initial attempt + 2 retries = 3 calls, then it stops (no infinite loop).
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('[TC-EMB-3] does not retry a non-retryable status (401)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const embedder = new GeminiEmbedder('test-key', 'gemini-embedding-001', 2)
    await expect(embedder.embed(['hello'])).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('[TC-EMB-4] retries a network error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(okResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const embedder = new GeminiEmbedder('test-key', 'gemini-embedding-001', 2)
    const [vec] = await embedder.embed(['hello'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vec).toHaveLength(2)
  })
})
