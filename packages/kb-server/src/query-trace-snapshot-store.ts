/**
 * Retains what retrieval actually did on a query, keyed by `requestId`, so a later
 * `submit_feedback` call can be enriched with it server-side.
 *
 * This exists because the agent submitting feedback cannot report any of it reliably. Feedback
 * arrives minutes later, often after the answer has scrolled out of the agent's own context, and
 * the MCP RunReport for a query is written with no collector — so it carries no retrieval trace to
 * join against afterwards. Capturing at query time is the only point where the information is
 * still available.
 *
 * Deliberately separate from `PendingFeedbackStore`: that queue is *advisory*, holds only sampled
 * queries, and is returned verbatim by `get_feedback_requests`, so folding trace payloads into it
 * would flood that response. This store is written on **every** query, so feedback on an unsampled
 * one still enriches, and is never surfaced to agents directly.
 *
 * In-memory and process-local, same as the pending queue: losing it on restart costs enrichment on
 * in-flight queries, nothing durable.
 */

import type { QueryFeedbackTrace } from './query-feedback-store.js'

export interface QueryTraceSnapshot {
  requestId: string
  base?: string
  trace: QueryFeedbackTrace
  ts: string
}

const MAX_SNAPSHOTS = 200
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000 // 6h

export class QueryTraceSnapshotStore {
  private entries = new Map<string, QueryTraceSnapshot>()

  record(requestId: string, base: string | undefined, trace: QueryFeedbackTrace): void {
    this.prune()
    this.entries.set(requestId, {
      requestId,
      ...(base ? { base } : {}),
      trace,
      ts: new Date().toISOString(),
    })
    while (this.entries.size > MAX_SNAPSHOTS) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  /** Snapshot for a requestId, or undefined when unknown or expired. */
  get(requestId: string): QueryTraceSnapshot | undefined {
    this.prune()
    return this.entries.get(requestId)
  }

  private prune(): void {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS
    for (const [id, entry] of this.entries) {
      if (new Date(entry.ts).getTime() < cutoff) this.entries.delete(id)
    }
  }
}
