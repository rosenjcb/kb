/**
 * Tracks `query` answers that were sampled for a feedback nudge
 * (`AGENT_INSTRUCTION`, gated by `KB_FEEDBACK_SAMPLE_RATE`) but haven't yet had
 * a matching `submit_feedback` call. Exposed to agents via `get_feedback_requests`
 * so a session can defer feedback to a natural checkpoint (e.g. after the work
 * is validated) instead of answering immediately, then come back and drain the
 * queue precisely — rather than re-scraping every query response for ids.
 *
 * In-memory and process-local by design: this is an advisory queue, not a
 * durable record (that's `QueryFeedbackStore`), so it is fine for it to reset
 * on restart. Entries expire after `PENDING_TTL_MS` and the store is capped at
 * `MAX_PENDING` so an abandoned session can't leak memory indefinitely.
 */

export interface PendingFeedbackEntry {
  requestId: string
  query: string
  ts: string
}

const MAX_PENDING = 200
const PENDING_TTL_MS = 6 * 60 * 60 * 1000 // 6h

export class PendingFeedbackStore {
  private entries = new Map<string, PendingFeedbackEntry>()

  /** Record a sampled query answer as awaiting feedback. */
  add(requestId: string, query: string): void {
    this.prune()
    this.entries.set(requestId, { requestId, query, ts: new Date().toISOString() })
    while (this.entries.size > MAX_PENDING) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  /** Clear a pending entry once feedback for it has been submitted. No-op if absent. */
  resolve(requestId: string): void {
    this.entries.delete(requestId)
  }

  /** Currently outstanding entries, oldest first. */
  list(): PendingFeedbackEntry[] {
    this.prune()
    return [...this.entries.values()]
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [id, entry] of this.entries) {
      if (new Date(entry.ts).getTime() < cutoff) this.entries.delete(id)
    }
  }
}
