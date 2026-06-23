/**
 * Thin client for the kb-server REST surface.
 *
 * `queryKb`  → POST /v1/query  — single-shot synthesized answer (channel @mentions)
 * `chatKb`   → POST /v1/chat   — multi-turn SSE stream, consumes the answer event (DMs)
 */

export interface QuerySource {
  title?: string
  filePath?: string
}

export interface QueryResult {
  status: string
  answer: string | null
  results: QuerySource[]
}

export async function queryKb({
  baseUrl,
  apiKey,
  question,
  timeoutMs = 60_000,
}: {
  baseUrl: string
  apiKey: string
  question: string
  timeoutMs?: number
}): Promise<QueryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ q: question }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`kb-server responded ${res.status}: ${detail.slice(0, 200)}`)
    }
    return (await res.json()) as QueryResult
  } finally {
    clearTimeout(timer)
  }
}

export async function chatKb({
  baseUrl,
  apiKey,
  sessionId,
  message,
  timeoutMs = 60_000,
}: {
  baseUrl: string
  apiKey: string
  sessionId: string
  message: string
  timeoutMs?: number
}): Promise<{ answer: string; results: QuerySource[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ sessionId, message }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`kb-server responded ${res.status}: ${detail.slice(0, 200)}`)
    }

    // Parse the SSE stream. Each event block is "event: TYPE\ndata: JSON\n\n".
    // We buffer the full body (timeout guards us) and scan for the answer event.
    const body = await res.text()
    for (const block of body.split('\n\n')) {
      let eventType = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim()
        if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (eventType === 'error' && data) {
        const parsed = JSON.parse(data) as { message?: string }
        throw new Error(parsed.message ?? 'Unknown error from kb-server chat')
      }
      if (eventType === 'answer' && data) {
        const parsed = JSON.parse(data) as { text?: string; sources?: QuerySource[] }
        return { answer: parsed.text ?? '', results: parsed.sources ?? [] }
      }
    }
    throw new Error('No answer event in kb-server chat stream')
  } finally {
    clearTimeout(timer)
  }
}
