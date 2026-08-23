#!/usr/bin/env node
/**
 * Read the agent feedback log and report what is actually in it.
 *
 * `submit_feedback` has always written NDJSON that nothing ever read. This is the reader: it joins
 * feedback records to their RunReport telemetry and summarizes the corpus, so the log can be judged
 * as a dataset before anyone tries to tune retrieval against it.
 *
 * Usage: node scripts/feedback-report.mjs [--feedback-dir DIR] [--logs-dir DIR] [--json]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Records below this are a sample to read by hand, not a corpus to fit parameters to. */
const DATASET_THRESHOLD = 200

function readNdjson(dir) {
  if (!dir || !fs.existsSync(dir)) return []
  const out = []
  for (const file of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A truncated trailing line is expected on a log being appended to concurrently.
      }
    }
  }
  return out
}

/**
 * Normalize the two record schemas the log has accumulated.
 *
 * Records written before the singular-`requestId` change carry `requestIds: string[]` and use a
 * top-level `requestId` to mean the *submitting* call's id, not the rated query's — reading those
 * with today's field meanings would silently mis-join roughly half the corpus.
 */
export function normalizeFeedbackRecord(raw) {
  const legacy = Array.isArray(raw.requestIds)
  const ratedIds = legacy
    ? raw.requestIds.filter(x => typeof x === 'string')
    : typeof raw.requestId === 'string'
      ? [raw.requestId]
      : []
  return {
    ts: raw.ts ?? null,
    schemaVersion: raw.schemaVersion ?? (legacy ? 'legacy' : 1),
    helped: raw.helped ?? null,
    query: raw.query ?? null,
    notes: raw.notes ?? null,
    base: raw.base ?? null,
    trace: raw.trace ?? null,
    scores: raw.scores ?? null,
    ratedRequestIds: ratedIds,
    feedbackRequestId: legacy ? (raw.requestId ?? null) : (raw.feedbackRequestId ?? null),
  }
}

/**
 * Join feedback to RunReports and summarize. Pure — takes parsed rows, returns a plain object — so
 * it can be exercised without touching the filesystem.
 */
export function summarizeFeedback(rawFeedback, runReports) {
  const records = rawFeedback.map(normalizeFeedbackRecord)
  // RunReport's join key is `sessionId`, not `requestId`; there is no `requestId` field on it.
  const bySession = new Map()
  for (const r of runReports) {
    if (typeof r.sessionId === 'string') bySession.set(r.sessionId, r)
  }

  const count = (pred) => records.filter(pred).length
  const tally = (pick) => {
    const m = {}
    for (const r of records) {
      const k = pick(r)
      if (k == null) continue
      m[k] = (m[k] ?? 0) + 1
    }
    return m
  }

  const joined = records.filter(r => r.ratedRequestIds.some(id => bySession.has(id)))

  return {
    total: records.length,
    is_dataset: records.length >= DATASET_THRESHOLD,
    by_schema: tally(r => String(r.schemaVersion)),
    helped: tally(r => r.helped),
    completeness: {
      with_rated_request_id: count(r => r.ratedRequestIds.length > 0),
      with_query: count(r => r.query),
      with_notes: count(r => r.notes),
      with_scores: count(r => r.scores),
      with_base: count(r => r.base),
      with_trace: count(r => r.trace),
    },
    join: {
      joinable_to_run_report: joined.length,
      orphaned: records.length - joined.length,
      run_reports_available: bySession.size,
    },
    helped_by_base: (() => {
      const m = {}
      for (const r of records) {
        if (!r.base || !r.helped) continue
        m[r.base] ??= {}
        m[r.base][r.helped] = (m[r.base][r.helped] ?? 0) + 1
      }
      return m
    })(),
    // The #219 question: does the evidence label track whether the answer was any good?
    helped_by_evidence: (() => {
      const m = {}
      for (const r of records) {
        const ev = r.trace?.evidence
        if (!ev || !r.helped) continue
        m[ev] ??= {}
        m[ev][r.helped] = (m[ev][r.helped] ?? 0) + 1
      }
      return m
    })(),
  }
}

function render(summary) {
  const L = []
  L.push(`feedback records: ${summary.total}`)
  if (!summary.is_dataset) {
    L.push('')
    L.push(
      `  NOT A DATASET YET — under ${DATASET_THRESHOLD} records. Read these by hand; do not fit`
    )
    L.push('  retrieval parameters to them. Any "trend" here is a handful of sessions.')
  }
  L.push('')
  L.push(`schema versions: ${JSON.stringify(summary.by_schema)}`)
  L.push(`helped:          ${JSON.stringify(summary.helped)}`)
  L.push('')
  L.push('field completeness')
  for (const [k, v] of Object.entries(summary.completeness)) {
    const pct = summary.total ? Math.round((v / summary.total) * 100) : 0
    L.push(`  ${k.padEnd(24)} ${String(v).padStart(4)} / ${summary.total}  (${pct}%)`)
  }
  L.push('')
  L.push('join to RunReport (feedback.requestId <-> report.sessionId)')
  L.push(`  joinable  ${summary.join.joinable_to_run_report}`)
  L.push(`  orphaned  ${summary.join.orphaned}`)
  L.push(`  reports   ${summary.join.run_reports_available}`)
  if (Object.keys(summary.helped_by_base).length) {
    L.push('')
    L.push('helped by base')
    for (const [b, counts] of Object.entries(summary.helped_by_base)) {
      L.push(`  ${b.padEnd(24)} ${JSON.stringify(counts)}`)
    }
  }
  if (Object.keys(summary.helped_by_evidence).length) {
    L.push('')
    L.push('helped by evidence label  (a label that tracks quality should separate these)')
    for (const [e, counts] of Object.entries(summary.helped_by_evidence)) {
      L.push(`  ${e.padEnd(24)} ${JSON.stringify(counts)}`)
    }
  }
  return L.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const home = process.env.KB_HOME?.trim() || path.join(os.homedir(), '.kb')
  const feedbackDir = arg('--feedback-dir', path.join(home, 'feedback'))
  const logsDir = arg('--logs-dir', path.join(home, 'logs'))

  const summary = summarizeFeedback(readNdjson(feedbackDir), readNdjson(logsDir))
  if (argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`feedback dir: ${feedbackDir}`)
  console.log(`logs dir:     ${logsDir}`)
  console.log('')
  console.log(render(summary))
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) main()
