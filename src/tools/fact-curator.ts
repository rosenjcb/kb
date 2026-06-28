import type { LLMProvider } from '../core/types'
import type { QueryResult } from './facts-document-reader'

/**
 * Fact curator — a judge-in-the-loop replacement for the old post-retrieval relevance
 * filter. After the research orchestrator dumps its island pool, the curator:
 *
 *   1. **Deterministically auto-keeps** facts with high token overlap (no LLM cost).
 *   2. Sends the remaining candidates to a single **structured LLM verdict** that returns
 *      which to keep, what is still missing (`gaps`), and whether the set is `sufficient`.
 *   3. **Hard-drops** everything the judge did not keep — no 15% floor — and, when the
 *      judge reports gaps and the set is not yet sufficient, issues **bounded re-discovery
 *      queries** to refill (so aggressive dropping is safe).
 *
 * Decisions are returned as an out-of-band {@link CurationRecord} for terminal / session-log
 * surfacing. They are **never** injected into the synthesis context — the whole point is to
 * shrink the prompt, so dropped facts simply leave; nothing announces their departure to the
 * model. On any LLM/parse error the curator fails safe: it returns the original set untouched.
 */

const DEFAULT_MIN_RESULTS_TO_CURATE = 12
const DEFAULT_AUTO_KEEP_OVERLAP = 0.5
const DEFAULT_MAX_ROUNDS = 2
const DEFAULT_MAX_REQUERIES = 2
const DEFAULT_REQUERY_BUDGET = 12
const DEFAULT_MIN_KEEP = 5
const JUDGE_SUMMARY_CHARS = 160
const JUDGE_MAX_KEPT_CONTEXT = 25

const CURATOR_STOP_WORDS = new Set([
  'what', 'where', 'when', 'which', 'who', 'why', 'how', 'does', 'the', 'and',
  'for', 'with', 'from', 'into', 'about', 'that', 'this', 'are', 'is', 'was',
  'were', 'has', 'have', 'can', 'will', 'its',
])

export interface CuratorOptions {
  /** Below this result count, curation is skipped (not worth an LLM call). */
  minResultsToCurate?: number
  /** Token-overlap fraction at/above which a fact is auto-kept without the LLM. */
  autoKeepOverlap?: number
  /** Hard cap on judge rounds (initial verdict + re-discovery re-judges). */
  maxRounds?: number
  /** Max re-discovery sub-queries issued per round. */
  maxRequeriesPerRound?: number
  /** Max facts pulled back per re-discovery sub-query. */
  requeryBudget?: number
  /** Absolute floor: if curation would empty the set, fall back to this many top facts. */
  minKeep?: number
}

export interface CurationRecord {
  /** Total facts the curator considered (incoming pool size). */
  evaluated: number
  /** Facts kept deterministically without an LLM call. */
  autoKept: number
  /** Hard-dropped facts with a short reason (out-of-band audit only). */
  dropped: Array<{ id: string; reason: string }>
  /** Re-discovery sub-queries the curator issued to refill gaps. */
  requeried: string[]
  /** Facts admitted via re-discovery. */
  added: number
  /** Judge rounds run. */
  rounds: number
  /** Judge's final sufficiency verdict. */
  sufficient: boolean
  /** True when the curator bailed to a safe fallback (LLM error or empty result guard). */
  fellBack: boolean
}

/** Bounded re-discovery: given a gap sub-query + ids to exclude, return up to `budget` facts. */
export type CuratorRequery = (
  gap: string,
  excludeIds: Set<string>,
  budget: number
) => Promise<QueryResult[]>

export interface CurateInput {
  llm: LLMProvider
  /** The user's actual question — NOT the graph-expanded retrieval string. */
  query: string
  results: QueryResult[]
  requery?: CuratorRequery
  options?: CuratorOptions
}

export interface CurateOutput {
  results: QueryResult[]
  record: CurationRecord
}

interface JudgeVerdict {
  keep: Set<string>
  gaps: string[]
  sufficient: boolean
}

export function shouldCurate(results: QueryResult[], options?: CuratorOptions): boolean {
  return results.length > (options?.minResultsToCurate ?? DEFAULT_MIN_RESULTS_TO_CURATE)
}

export async function curateFacts(input: CurateInput): Promise<CurateOutput> {
  const { llm, query, results } = input
  const opts = {
    autoKeepOverlap: input.options?.autoKeepOverlap ?? DEFAULT_AUTO_KEEP_OVERLAP,
    maxRounds: input.options?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxRequeriesPerRound: input.options?.maxRequeriesPerRound ?? DEFAULT_MAX_REQUERIES,
    requeryBudget: input.options?.requeryBudget ?? DEFAULT_REQUERY_BUDGET,
    minKeep: input.options?.minKeep ?? DEFAULT_MIN_KEEP,
  }

  const record: CurationRecord = {
    evaluated: results.length,
    autoKept: 0,
    dropped: [],
    requeried: [],
    added: 0,
    rounds: 0,
    sufficient: false,
    fellBack: false,
  }

  const queryTokens = tokenize(query)
  const incomingIds = new Set(results.map(r => r.metadata.id))

  // 1. Deterministic partition: obvious keeps skip the LLM entirely.
  const autoKept: QueryResult[] = []
  let candidates: QueryResult[] = []
  for (const r of results) {
    if (overlapFraction(queryTokens, factText(r)) >= opts.autoKeepOverlap) autoKept.push(r)
    else candidates.push(r)
  }
  record.autoKept = autoKept.length

  const keptIds = new Set(autoKept.map(r => r.metadata.id))
  const knownIds = new Set(incomingIds)
  const discovered: QueryResult[] = []

  try {
    while (record.rounds < opts.maxRounds) {
      if (candidates.length === 0) break

      const verdict = await runJudge(llm, query, autoKept, candidates)
      record.rounds++

      for (const r of candidates) {
        if (verdict.keep.has(r.metadata.id)) {
          keptIds.add(r.metadata.id)
        } else {
          record.dropped.push({ id: r.metadata.id, reason: 'judged off-topic for query' })
        }
      }
      record.sufficient = verdict.sufficient

      const moreRounds = record.rounds < opts.maxRounds
      if (verdict.sufficient || !input.requery || verdict.gaps.length === 0 || !moreRounds) break

      // 2. Bounded re-discovery — refill the gaps the judge named.
      const fresh: QueryResult[] = []
      for (const gap of verdict.gaps.slice(0, opts.maxRequeriesPerRound)) {
        record.requeried.push(gap)
        const found = await input.requery(gap, knownIds, opts.requeryBudget)
        for (const f of found) {
          if (knownIds.has(f.metadata.id)) continue
          knownIds.add(f.metadata.id)
          fresh.push(f)
          discovered.push(f)
        }
      }
      record.added += fresh.length
      if (fresh.length === 0) break
      candidates = fresh // next round judges only the newly discovered facts
    }
  } catch {
    record.fellBack = true
    return { results, record }
  }

  // Stable order: original pool order for survivors, then re-discovered facts in discovery order.
  const survivors = results.filter(r => keptIds.has(r.metadata.id))
  const kept = [...survivors, ...discovered.filter(r => keptIds.has(r.metadata.id))]

  if (kept.length === 0) {
    record.fellBack = true
    return { results: deterministicTopK(results, queryTokens, opts.minKeep), record }
  }

  return { results: kept, record }
}

async function runJudge(
  llm: LLMProvider,
  query: string,
  kept: QueryResult[],
  candidates: QueryResult[]
): Promise<JudgeVerdict> {
  const keptContext =
    kept.length > 0
      ? [
          'Already kept (context — do not re-list):',
          ...kept.slice(0, JUDGE_MAX_KEPT_CONTEXT).map(r => `- ${summary(r)}`),
          '',
        ]
      : []

  const candidateLines = candidates.map(r => `${r.metadata.id}|${summary(r)}`)

  const response = await llm.call({
    messages: [
      {
        role: 'user',
        content: [
          `Query: ${query}`,
          '',
          'You are curating knowledge-base facts to answer the query above.',
          'Keep only facts that help answer it; drop facts about unrelated topics.',
          '',
          ...keptContext,
          'Candidate facts (id|summary):',
          ...candidateLines,
          '',
          'Return ONLY a JSON object, no prose:',
          '{"keep": ["<id>", ...], "gaps": ["<short search query>", ...], "sufficient": true|false}',
          '- keep: ids of candidates relevant to the query.',
          '- gaps: up to 2 short follow-up searches for info still missing to answer; [] if none.',
          '- sufficient: true if the kept facts fully answer the query.',
        ].join('\n'),
      },
    ],
    temperature: 0,
    maxTokens: 800,
    thinkingBudget: 0,
  })

  return parseVerdict(response.text)
}

export function parseVerdict(text: string): JudgeVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('curator: no JSON object in judge response')
  const parsed = JSON.parse(match[0]) as {
    keep?: unknown
    gaps?: unknown
    sufficient?: unknown
  }
  const keep = new Set<string>(
    Array.isArray(parsed.keep) ? parsed.keep.filter((x): x is string => typeof x === 'string') : []
  )
  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : []
  return { keep, gaps, sufficient: parsed.sufficient === true }
}

function summary(r: QueryResult): string {
  const title = (r.metadata.title ?? '').trim()
  const body = title || (r.content ?? '').trim()
  return body.slice(0, JUDGE_SUMMARY_CHARS).replace(/\s+/g, ' ')
}

function factText(r: QueryResult): string {
  return `${r.metadata.title ?? ''} ${r.content ?? ''}`
}

function tokenize(input: string): string[] {
  const expanded = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return [
    ...new Set(
      expanded
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !CURATOR_STOP_WORDS.has(token))
    ),
  ]
}

function overlapFraction(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0
  const textTokens = new Set(tokenize(text))
  const hit = queryTokens.filter(token => textTokens.has(token)).length
  return hit / queryTokens.length
}

function deterministicTopK(
  results: QueryResult[],
  queryTokens: string[],
  k: number
): QueryResult[] {
  return [...results]
    .map(r => ({ r, score: overlapFraction(queryTokens, factText(r)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k))
    .map(entry => entry.r)
}
