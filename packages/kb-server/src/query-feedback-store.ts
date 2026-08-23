/**
 * Durable store for agent feedback submitted via the `submit_feedback` MCP tool.
 *
 * Named "query feedback" to stay distinct from the doc-generation feedback flow
 * in `@kb/core` (doc-feedback-classifier): this file is about whether query
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

/**
 * What retrieval actually did on the query this feedback is about, captured server-side at query
 * time rather than reconstructed later.
 *
 * Without this the log is unanalysable: MCP RunReports are written with no collector, so they carry
 * no retrieval trace, and a reader joining on `requestId` recovers nothing but timestamps. Every
 * judgement about *why* an answer was rated badly then has to come from freeform prose in `notes`.
 */
export interface QueryFeedbackTrace {
  evidence?: string
  sourceCount: number
  sourcePaths: string[]
  noteCount: number
  /** Prose claims the opt-in verify pass flagged as unsupported (#223), when it ran. */
  unsupportedClaims?: string[]
  /** True when the answer cited a file absent from the sources (#220/#221). */
  hadUngroundedFiles?: boolean
  answerError?: string
}

export interface QueryFeedbackRecord {
  /** ISO-8601 write timestamp, set by the store. */
  ts: string
  /** Record shape. Absent on pre-enrichment records, which a reader must still handle. */
  schemaVersion?: 2
  /** Where the feedback arrived from. MCP is the only writer today. */
  source: 'mcp'
  /** requestId of the submit_feedback call itself (joins its own RunReport line). */
  feedbackRequestId?: string
  helped: FeedbackHelped
  notes?: string
  /** The query question this feedback is about, as echoed by the agent. */
  query?: string
  /** The answer that was rated, when the elicitation path captured it. */
  answer?: string
  /** requestId of the specific query response this feedback answers, if any (joins its RunReport line). */
  requestId?: string
  /** Base that served the rated answer — the signal a wrong-base report needs (#233). */
  base?: string
  trace?: QueryFeedbackTrace
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
