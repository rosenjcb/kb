/**
 * Durable store for agent feedback submitted via the `submit_feedback` MCP tool.
 *
 * Named "query feedback" to stay distinct from the doc-generation feedback flow
 * in `@kb/core` (doc-feedback-classifier): this file is about whether kb_query
 * answers actually held up for the calling agent.
 *
 * Records are NDJSON, one line per submission, date-partitioned like the
 * RunReport telemetry files (`~/.kb/logs/`): `<feedbackDir>/<YYYY-MM-DD>.jsonl`.
 * Writes never throw — feedback capture must never break an MCP response.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { log } from './logger.js'

export type FeedbackHelped = 'yes' | 'partial' | 'no'

/** Optional 0–4 axis scores mirroring the offline evaluation vocabulary (EVALUATION.md). */
export interface FeedbackScores {
  correctness?: number
  usefulness?: number
  relevance?: number
  specificity?: number
  evidence_handling?: number
}

export interface QueryFeedbackRecord {
  /** ISO-8601 write timestamp, set by the store. */
  ts: string
  /** Where the feedback arrived from. MCP is the only writer today. */
  source: 'mcp'
  /** requestId of the submit_feedback call itself (joins its own RunReport line). */
  requestId?: string
  helped: FeedbackHelped
  notes?: string
  /** The kb_query answer text this feedback is about, as echoed by the agent. */
  answer?: string
  /** The kb_query question(s) this feedback is about, as echoed by the agent. */
  query?: string
  /** requestId values echoed from earlier kb_query responses (joins their RunReport lines). */
  requestIds?: string[]
  scores?: FeedbackScores
}

/** Resolve the default feedback directory. Prefers KB_HOME when set (server/container use). */
export function defaultFeedbackDir(): string {
  const kbHome = process.env.KB_HOME?.trim()
  if (kbHome) return path.join(kbHome, 'feedback')
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir()
  return path.join(home, '.kb', 'feedback')
}

/**
 * Appends feedback records to `<dir>/<YYYY-MM-DD>.jsonl`.
 * Creates the directory on first write. Never throws — warns on failure.
 */
export class QueryFeedbackStore {
  constructor(private dir: string) {}

  async append(record: QueryFeedbackRecord): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const date = record.ts.slice(0, 10)
      const file = path.join(this.dir, `${date}.jsonl`)
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf-8')
    } catch (err) {
      log.warn('could not write query feedback', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
