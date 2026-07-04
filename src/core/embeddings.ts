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
 * The embedder is optional everywhere: when none is configured (no API key, offline), callers
 * fall back to the deterministic vector and behave exactly as before.
 */

export interface Embedder {
  /** Stable id stored on each embedding row so real vs. legacy vectors are distinguishable. */
  readonly modelId: string
  readonly dimensions: number
  /** Embed a batch of texts; returns one unit-normalized vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>
}

/** Max texts per Gemini batchEmbedContents request. */
const GEMINI_BATCH_SIZE = 100

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
    const body = {
      requests: texts.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        outputDimensionality: this.dimensions,
      })),
    }
    const response = await fetch(
      `${this.apiBase()}/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      throw new Error(`[gemini-embed] request failed (${response.status}): ${detail.slice(0, 200)}`)
    }
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
 * Select the embedding backend. Local (on-device, no API) is the default; set
 * `KB_EMBEDDER=gemini` to opt into hosted Gemini embeddings. Returns `undefined` when the chosen
 * backend is unavailable (no local dependency and no Gemini key), so every caller degrades
 * gracefully to the deterministic vector.
 */
export function createEmbedder(): Embedder | undefined {
  const backend = process.env.KB_EMBEDDER?.trim().toLowerCase()
  if (backend === 'gemini') {
    const geminiKey = process.env.GEMINI_API_KEY?.trim()
    if (geminiKey) return new GeminiEmbedder(geminiKey)
    return undefined
  }
  if (backend === 'none') return undefined
  // Default: local, on-device weights.
  return new LocalEmbedder()
}

/** @deprecated use {@link createEmbedder}; kept for callers still keying off the env directly. */
export function createEmbedderFromEnv(): Embedder | undefined {
  return createEmbedder()
}
