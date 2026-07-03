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
 * Build an embedder from the environment, mirroring the provider auto-detection used for the
 * chat/synthesis LLM. Returns `undefined` when no embedding-capable key is present, so every
 * caller degrades gracefully to the deterministic vector.
 */
export function createEmbedderFromEnv(): Embedder | undefined {
  const geminiKey = process.env.GEMINI_API_KEY?.trim()
  if (geminiKey) return new GeminiEmbedder(geminiKey)
  return undefined
}
