import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GeminiEmbedder,
  createEmbedder,
  requireEmbedderForInit,
} from '@kb/core/core/embeddings.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const prevEmbedder = process.env.KB_EMBEDDER
const prevGeminiKey = process.env.GEMINI_API_KEY

afterEach(() => {
  if (prevEmbedder === undefined) delete process.env.KB_EMBEDDER
  else process.env.KB_EMBEDDER = prevEmbedder
  if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = prevGeminiKey
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createEmbedder / KB_EMBEDDER', () => {
  it('[TC-6LYC] Given KB_EMBEDDER unset, when createEmbedder runs, then it returns Local ONNX', () => {
    delete process.env.KB_EMBEDDER
    const e = createEmbedder()
    expect(e.modelId.startsWith('local:')).toBe(true)
    expect(e.dimensions).toBe(384)
  })

  it('[TC-0Q63] Given KB_EMBEDDER=local or onnx, when createEmbedder runs, then it returns Local ONNX', () => {
    for (const value of ['local', 'onnx', 'LOCAL', ' Onnx ']) {
      process.env.KB_EMBEDDER = value
      const e = createEmbedder()
      expect(e.modelId.startsWith('local:'), value).toBe(true)
    }
  })

  it('[TC-9QQ4] Given KB_EMBEDDER=gemini without GEMINI_API_KEY, when createEmbedder runs, then it throws before any network call', () => {
    process.env.KB_EMBEDDER = 'gemini'
    delete process.env.GEMINI_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(() => createEmbedder()).toThrow(/GEMINI_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('[TC-XR8H] Given KB_EMBEDDER=gemini with a key, when createEmbedder runs, then modelId starts with gemini:', () => {
    process.env.KB_EMBEDDER = 'gemini'
    process.env.GEMINI_API_KEY = 'test-key'
    const e = createEmbedder()
    expect(e.modelId.startsWith('gemini:')).toBe(true)
    expect(e.dimensions).toBe(768)
  })

  it('[TC-W56K] Given KB_EMBEDDER=none or openai, when createEmbedder runs, then it throws an unknown-backend error', () => {
    for (const value of ['none', 'openai']) {
      process.env.KB_EMBEDDER = value
      expect(() => createEmbedder()).toThrow(/Unknown KB_EMBEDDER/)
    }
  })

  it('[smoke] requireEmbedderForInit matches createEmbedder selection', () => {
    delete process.env.KB_EMBEDDER
    expect(requireEmbedderForInit().modelId).toBe(createEmbedder().modelId)
  })
})

describe('GeminiEmbedder failure modes', () => {
  beforeEach(() => {
    process.env.KB_GEMINI_EMBED_MIN_INTERVAL_MS = '0'
    process.env.KB_GEMINI_EMBED_MAX_RETRIES = '2'
  })

  afterEach(() => {
    delete process.env.KB_GEMINI_EMBED_MIN_INTERVAL_MS
    delete process.env.KB_GEMINI_EMBED_MAX_RETRIES
  })

  it('[TC-D9SP][TC-80AI] Given Gemini returns 401, when embed runs, then it throws (hard-fail, no success path)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'API key not valid',
    })
    vi.stubGlobal('fetch', fetchMock)
    const embedder = new GeminiEmbedder('bad-key')
    await expect(embedder.embed(['hello'])).rejects.toThrow(/gemini-embed.*401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('[TC-L7HH] Given HTTP 429 resource_exhausted with Retry-After, when embed runs, then it retries with sleep', async () => {
    const sleep = vi.spyOn(globalThis, 'setTimeout')
    let calls = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '0' }),
          text: async () => 'resource_exhausted: slow down',
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          embeddings: [{ values: Array.from({ length: 768 }, () => 0.01) }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const embedder = new GeminiEmbedder('key')
    const vectors = await embedder.embed(['text'])
    expect(vectors).toHaveLength(1)
    expect(vectors[0]).toHaveLength(768)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    sleep.mockRestore()
  })

  it('[TC-BEY0] Given quota/billing body text, when embed runs, then it fails on the first response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'You exceeded your current quota. See billing details.',
    })
    vi.stubGlobal('fetch', fetchMock)
    const embedder = new GeminiEmbedder('key')
    await expect(embedder.embed(['text'])).rejects.toThrow(/gemini-embed/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('SqliteKbIndexer embed without backend', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kb-embed-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('[TC-DVAP] Given embedAllDocuments with no embedder attached, when it runs, then it throws', async () => {
    const indexer = new SqliteKbIndexer({ dbPath: path.join(dir, 'kb-index.sqlite') })
    indexer.upsertDocument({
      gitRepo: 'demo',
      relPath: 'a.md',
      title: 'A',
      body: 'body',
    })
    await expect(indexer.embedAllDocuments()).rejects.toThrow(/no embedder attached/)
    indexer.close()
  })
})
