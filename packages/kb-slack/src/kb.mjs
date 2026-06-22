/**
 * Thin client for the kb-server REST surface — the same `POST /v1/query` contract apps use
 * (see packages/kb-server/http/HTTP.md). Bearer-authenticated; bounded by a timeout.
 */

/** Query kb-server for a synthesized answer. Returns the parsed `/v1/query` body. */
export async function queryKb({ baseUrl, apiKey, question, timeoutMs = 60_000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ q: question }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`kb-server responded ${res.status}: ${detail.slice(0, 200)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}
