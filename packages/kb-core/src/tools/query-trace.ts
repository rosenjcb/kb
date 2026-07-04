import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import type { CurationRecord } from './fact-curator'
import type { FactRow } from './sqlite-kb-index'

/**
 * Opt-in deep query trace.
 *
 * Off by default. `kb query --trace` (or `KB_QUERY_TRACE=true`) turns it on, and the deep
 * facts loop writes a **full content dump** of the retrieval to `~/.kb/traces/<traceId>.json`:
 * every fact the walk surfaced (with score + content), the per-pass decision breadcrumbs, the
 * facts that fell below the score floor, and the facts the curator kicked out (with the judge's
 * reason). It answers the question the aggregate telemetry cannot — *did the loop actually hold
 * the fact it needed and drop it, or never find it at all?*
 *
 * This is a diagnostic artifact only: it is **never** fed back into synthesis, and it never
 * shows up in the answer or the eval score. It is written out-of-band, next to the run logs.
 */

/** True only when `KB_QUERY_TRACE` is explicitly `true` (case-insensitive). Default: off. */
export function isQueryTraceEnabled(): boolean {
  return process.env.KB_QUERY_TRACE?.trim().toLowerCase() === 'true'
}

export interface TracedFact {
  id: string
  title: string
  score: number
  sourceKind: string
  repo?: string
  /** Full fact text (or source text for code facts) — the point of a trace is to see it. */
  content: string
}

export interface QueryTraceLane {
  /** The sub-query this lane ran: the base query, or one expansion variant. */
  query: string
  knobs: {
    maxIterations: number
    maxGraphHops: number
    maxPonds: number
    perIterationLimit: number
  }
  iterations: number
  graphHops: number
  pondCount: number
  stopReason: string
  /** Per-pass count breadcrumbs (frontier / merge / hop counts), in order. */
  passTrace: string[]
  /** Per-pass stop/continue decisions. */
  checkpoints: Array<{ stage: string; status: string; nextAction: string; confidence: number }>
  /** Every fact the walk surfaced, best score first — the "what it discovered" record. */
  discovered: TracedFact[]
  /** Ids that survived ranking and reached curation (pre-curation result set). */
  returned: string[]
  /** Discovered facts cut below the score floor before curation ever ran. */
  droppedBelowFloor: TracedFact[]
}

export interface QueryTraceCuration {
  evaluated: number
  autoKept: number
  kept: number
  /** Facts the curator kicked out, with the judge's reason and full content. */
  dropped: Array<TracedFact & { reason: string }>
  requeried: string[]
  added: number
  rounds: number
  sufficient: boolean
  fellBack: boolean
}

export interface QueryTraceDump {
  traceId: string
  createdAt: string
  query: string
  lanes: QueryTraceLane[]
  curation?: QueryTraceCuration
}

function summarizeTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69)}...`
}

export function tracedFactFromRow(row: FactRow, score: number): TracedFact {
  return {
    id: row.id,
    title: summarizeTitle(row.fact_text),
    score: Number(score.toFixed(4)),
    sourceKind: row.source_kind,
    ...(row.git_repo ? { repo: row.git_repo } : {}),
    content:
      row.source_kind === 'import_code' && row.source_text ? row.source_text : row.fact_text,
  }
}

/**
 * Fold the curator's out-of-band record into the trace. The record only carries `{ id, reason }`
 * per drop, so recover each dropped fact's title/score/content by id from what the lanes already
 * discovered (falling back to placeholders if the id somehow isn't in the discovery pool).
 */
export function buildCurationTrace(
  record: CurationRecord,
  lanes: QueryTraceLane[],
  keptCount: number
): QueryTraceCuration {
  const byId = new Map<string, TracedFact>()
  for (const lane of lanes) {
    for (const fact of lane.discovered) {
      if (!byId.has(fact.id)) byId.set(fact.id, fact)
    }
  }
  const dropped = record.dropped.map(entry => {
    const fact = byId.get(entry.id)
    return {
      id: entry.id,
      title: fact?.title ?? '(not in discovery pool)',
      score: fact?.score ?? 0,
      sourceKind: fact?.sourceKind ?? 'unknown',
      ...(fact?.repo ? { repo: fact.repo } : {}),
      content: fact?.content ?? '',
      reason: entry.reason,
    }
  })
  return {
    evaluated: record.evaluated,
    autoKept: record.autoKept,
    kept: keptCount,
    dropped,
    requeried: record.requeried,
    added: record.added,
    rounds: record.rounds,
    sufficient: record.sufficient,
    fellBack: record.fellBack,
  }
}

export function newTraceId(): string {
  return `qtrace-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`
}

/** Write the dump to `<dir>/<traceId>.json`, creating the directory on first use. */
export async function writeQueryTrace(dir: string, dump: QueryTraceDump): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${dump.traceId}.json`)
  await writeFile(file, `${JSON.stringify(dump, null, 2)}\n`, 'utf-8')
  return file
}
