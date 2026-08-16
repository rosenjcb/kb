/**
 * Real neural text embeddings for semantic fact scoring.
 *
 * Retrieval scoring historically used {@link buildDeterministicVector} — a SHA256 hash of the
 * whole string spread into a vector. That is a lexical fingerprint, not a meaning vector: two
 * texts that share most of their words hash to unrelated vectors, so the "semantic" cosine was
 * effectively noise. This module provides a real embedder so the semantic component can bridge
 * vocabulary gaps (e.g. a question about "directories/paths" matching docs about
 * "basename / dir-only / repo root").
 *
 * Backend selection ({@link createEmbedder}) is strict: an unset/`local`/`onnx` `KB_EMBEDDER`
 * always selects Local ONNX, `gemini` requires `GEMINI_API_KEY` or throws, and any other value
 * throws — there is no silent no-op backend. Index builds need real vectors to match the
 * serving node's `model_id`, so misconfiguration must fail loudly rather than degrade quietly.
 * Query-time embedding is a separate, deliberately best-effort path (see
 * `cacheQueryEmbedding`): a single failed query embed falls back to the hash vector instead of
 * 503ing chat, since index builds and live queries have very different failure budgets.
 */

export interface Embedder {
  /** Stable id stored on each embedding row so real vs. legacy vectors are distinguishable. */
  readonly modelId: string
  readonly dimensions: number
  /** Embed a batch of texts; returns one unit-normalized vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>
  /** Optional callback invoked on transient retry backoff attempts. */
  onRetry?: (attempt: number, maxRetries: number, reason: string, waitMs: number) => void
}

/** Max texts per Gemini batchEmbedContents request. */
const GEMINI_BATCH_SIZE = 100

/**
 * Transient HTTP statuses worth retrying: rate limit (429), request timeout (408), and the
 * 5xx family. Everything else (auth, bad request) is a hard failure — retrying can't fix it.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** Retry budget for a single embed request. `0` disables retries. Env-overridable for tests/tuning. */
function embedMaxRetries(): number {
  const raw = Number(process.env.KB_EMBED_MAX_RETRIES)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5
}

/** Cap on any single backoff wait, so an absurd `Retry-After` can't stall a run for minutes. */
function embedMaxBackoffMs(): number {
  const raw = Number(process.env.KB_EMBED_MAX_BACKOFF_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000
}

/**
 * Parse a `Retry-After` header into milliseconds. The header is either delta-seconds
 * (`"12"`) or an HTTP-date; both forms are honored, negative/unparseable → undefined so the
 * caller falls back to exponential backoff.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return undefined
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function normalize(vector: number[]): number[] {
  let norm = 0
  for (const v of vector) norm += v * v
  norm = Math.sqrt(norm)
  if (norm === 0) return vector
  return vector.map(v => v / norm)
}

export class GeminiEmbedder implements Embedder {
  readonly modelId: string
  readonly dimensions: number
  private readonly model: string
  onRetry?: (attempt: number, maxRetries: number, reason: string, waitMs: number) => void

  constructor(
    private readonly apiKey: string,
    model = 'gemini-embedding-001',
    dimensions = 768
  ) {
    this.model = model
    this.dimensions = dimensions
    // Include the output dimensionality: truncated MRL vectors are not comparable across dims.
    this.modelId = `gemini:${model}:${dimensions}`
  }

  private apiBase(): string {
    const override = process.env.GEMINI_API_BASE_URL?.trim()
    return override ? override.replace(/\/$/, '') : 'https://generativelanguage.googleapis.com'
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += GEMINI_BATCH_SIZE) {
      const batch = texts.slice(i, i + GEMINI_BATCH_SIZE)
      out.push(...(await this.embedBatch(batch)))
    }
    return out
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({
      requests: texts.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        outputDimensionality: this.dimensions,
      })),
    })
    const url = `${this.apiBase()}/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`
    const maxRetries = embedMaxRetries()
    let lastError = ''
    // Rate limits (429) and transient 5xx/network hiccups are absorbed here with bounded
    // exponential backoff (honoring `Retry-After`) so a busy provider degrades to a slower
    // run, not a crash — both under eval load and in a live server. The budget is finite:
    // once it's spent the request throws, so a truly exhausted quota fails fast instead of
    // looping forever.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt >= maxRetries) {
          throw new Error(
            `[gemini-embed] request failed after ${attempt + 1} attempt(s): ${lastError.slice(0, 200)}`
          )
        }
        await this.backoff(attempt, undefined, lastError)
        continue
      }

      if (response.ok) {
        const data = (await response.json()) as { embeddings?: Array<{ values?: number[] }> }
        const embeddings = data.embeddings ?? []
        if (embeddings.length !== texts.length) {
          throw new Error(
            `[gemini-embed] expected ${texts.length} embeddings, got ${embeddings.length}`
          )
        }
        // Truncated MRL vectors must be re-normalized to unit length before cosine comparison.
        return embeddings.map(e => normalize(e.values ?? []))
      }

      const detail = await response.text().catch(() => response.statusText)
      lastError = `${response.status}: ${detail.slice(0, 200)}`
      // Retry every transient HTTP status in the bounded budget. Some providers emit 429
      // "quota/billing" text for burst overage as well as hard exhaustion, so treat 429 as
      // transient here and let the finite retry budget decide when to fail.
      const retryable = RETRYABLE_STATUS.has(response.status)
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`[gemini-embed] request failed (${response.status}): ${detail.slice(0, 200)}`)
      }
      await this.backoff(attempt, retryAfterMs(response.headers.get('retry-after')), lastError)
    }
    // Unreachable: the loop either returns or throws on the final attempt. Guards the type.
    throw new Error(`[gemini-embed] request failed: ${lastError.slice(0, 200)}`)
  }

  /**
   * Wait before the next attempt: `Retry-After` when the provider sent one, otherwise
   * exponential backoff (1s, 2s, 4s, …) with jitter, capped so a single wait stays bounded.
   */
  private async backoff(attempt: number, retryAfter: number | undefined, reason: string): Promise<void> {
    const maxRetries = embedMaxRetries()
    const exponential = 1000 * 2 ** attempt
    const jitter = Math.floor(Math.random() * 250)
    const waitMs = Math.min(retryAfter ?? exponential + jitter, embedMaxBackoffMs())
    this.onRetry?.(attempt + 1, maxRetries, reason, waitMs)
    console.warn(
      `[gemini-embed] transient error (${reason.slice(0, 120)}); retrying in ${Math.round(waitMs)}ms`
    )
    await sleep(waitMs)
  }
}

/**
 * Local, in-process embedder backed by a small ONNX sentence-transformer via
 * `@huggingface/transformers`. Truly local: model weights run on-device, no API call, no data
 * leaves the machine. The dependency and model are loaded lazily on first use, so environments
 * that never select the local backend pay nothing (and installs without the optional dependency
 * still work — {@link createEmbedder} falls back).
 */
export class LocalEmbedder implements Embedder {
  readonly modelId: string
  readonly dimensions = 384 // all-MiniLM-L6-v2
  private readonly modelName: string
  // biome-ignore lint/suspicious/noExplicitAny: transformers.js pipeline type is loaded lazily.
  private extractor: Promise<any> | null = null

  constructor(modelName = 'Xenova/all-MiniLM-L6-v2') {
    this.modelName = modelName
    this.modelId = `local:${modelName}:${this.dimensions}`
  }

  private async pipeline() {
    if (!this.extractor) {
      this.extractor = (async () => {
        const { pipeline } = await import('@huggingface/transformers')
        return pipeline('feature-extraction', this.modelName)
      })()
    }
    return this.extractor
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const extractor = await this.pipeline()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    // output.tolist() → number[][] (one unit-normalized row per input).
    return output.tolist() as number[][]
  }
}

/**
 * Select the embedding backend. `KB_EMBEDDER` pin wins: unset/empty, `local`, or `onnx`
 * selects Local ONNX; `gemini` selects Gemini and requires a non-empty `GEMINI_API_KEY`
 * (thrown before any network call otherwise); any other value throws — there is no `none`
 * backend and a present `GEMINI_API_KEY` alone no longer auto-selects Gemini, so the pin is
 * always explicit and index builds never silently pick a different backend than intended.
 */
export function createEmbedder(): Embedder {
  const raw = process.env.KB_EMBEDDER
  const backend = raw?.trim().toLowerCase() ?? ''
  if (backend === '' || backend === 'local' || backend === 'onnx') return new LocalEmbedder()
  if (backend === 'gemini') {
    const geminiKey = process.env.GEMINI_API_KEY?.trim()
    if (!geminiKey) throw new Error('KB_EMBEDDER=gemini requires GEMINI_API_KEY to be set')
    return new GeminiEmbedder(geminiKey)
  }
  throw new Error(`Unknown KB_EMBEDDER: "${raw}"`)
}

/** Same selection as {@link createEmbedder}, named for init call sites that must hard-fail. */
export function requireEmbedderForInit(): Embedder {
  return createEmbedder()
}

/** @deprecated use {@link createEmbedder}; kept for callers still keying off the env directly. */
export function createEmbedderFromEnv(): Embedder {
  return createEmbedder()
}
