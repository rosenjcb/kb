/**
 * Post-draft contradiction search (#146).
 *
 * After synthesis produces a draft answer, extract core claims, run one shallow
 * adversarial retrieval pass for disconfirming evidence, filter true
 * contradictions, and optionally revise the answer. Fail-safe: any error keeps
 * the draft and still records telemetry (`ran` / `found` / `used`).
 */

import { formatFactUri, sourceRefToPath } from '@kb/core/core/fact-uri.js'
import {
  MAX_FACT_CONTENT_CHARS,
  formatRetrievedFactsForLLM,
} from '@kb/core/core/retrieval-context.js'
import { type RunCollector, estimateCost } from '@kb/core/core/telemetry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import {
  type ReadDocumentsResultData,
  type ReadDocumentsResultItem,
  isReadFactsResult,
} from './intent-cli.js'

const MAX_CLAIMS = 3
const REQUERY_BUDGET = 12
const CLAIM_MAX_TOKENS = 400
const FILTER_MAX_TOKENS = 400
const REVISE_MAX_TOKENS = (() => {
  const raw = process.env.KB_QUERY_MAX_OUTPUT_TOKENS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 32768
})()

export interface ContradictionTrace {
  ran: boolean
  found: boolean
  used: boolean
  hitCount?: number
  queries?: string[]
  factIds?: string[]
  /** Supporting facts counted for confidence (#153). */
  supportCount?: number
  /** Contradicting facts counted for confidence (#153). */
  contradictCount?: number
  /** Checkpoint/router confidence before contradiction adjustment. */
  confidenceBefore?: number
  /** Adjusted confidence after support vs contradict mass. */
  confidenceAfter?: number
}

/**
 * FR-24 extension (#153): shrink checkpoint confidence by the share of
 * contradicting vs supporting evidence counts.
 *
 * `confidence = base * support / (support + contradict)` when contradict > 0;
 * unchanged when contradict is 0.
 */
export function confidenceFromSupportAndContradiction(
  baseConfidence: number,
  supportCount: number,
  contradictCount: number
): number {
  const base = Math.max(0, Math.min(1, baseConfidence))
  const support = Math.max(0, supportCount)
  const contradict = Math.max(0, contradictCount)
  if (contradict === 0) return base
  const denom = support + contradict
  if (denom <= 0) return base
  return Math.max(0, Math.min(1, base * (support / denom)))
}

function baseConfidenceFromResult(result: IntentResult): number {
  if (typeof result.confidence === 'number' && Number.isFinite(result.confidence)) {
    return Math.max(0, Math.min(1, result.confidence))
  }
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const checkpoints = data.retrieval?.checkpoints
  if (Array.isArray(checkpoints)) {
    for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
      const value = checkpoints[i]?.confidence
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value))
      }
    }
  }
  return 0.8
}

export interface ContradictionSearchParams {
  question: string
  result: IntentResult
  llm: LLMProvider
  baseDir: string
  collector?: RunCollector
  /** Stage name prefix (default `query_truth`). */
  intent?: string
  /**
   * Test seam: override shallow FTS. When omitted, opens the base's sqlite index.
   * Return up to `limit` candidate facts (caller still applies excludeIds + budget).
   */
  searchFacts?: (
    query: string,
    limit: number
  ) => Array<{
    id: string
    fact_text: string
    source_kind?: string
    source_ref?: string | null
    source_text?: string | null
    git_repo?: string | null
    created_at?: string
    updated_at?: string
  }>
}

interface ClaimPlan {
  claim: string
  disproveQuery: string
}

function emptyTrace(ran: boolean): ContradictionTrace {
  return { ran, found: false, used: false }
}

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('contradiction-search: no JSON object in LLM response')
  return JSON.parse(match[0])
}

function recordStage(
  collector: RunCollector | undefined,
  stage: string,
  llm: LLMProvider,
  startedAt: string,
  startMs: number,
  usage: { inputTokens: number; outputTokens: number }
): void {
  if (!collector) return
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return
  collector.addStage({
    stage,
    startedAt,
    durationMs: Date.now() - startMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: estimateCost(llm.name, llm.model, usage.inputTokens, usage.outputTokens),
    provider: llm.name,
    model: llm.model,
  })
}

function rowToItem(row: {
  id: string
  fact_text: string
  source_kind?: string
  source_ref?: string | null
  source_text?: string | null
  git_repo?: string | null
}): ReadDocumentsResultItem {
  const content =
    row.source_kind === 'import_code' && row.source_text ? row.source_text : row.fact_text
  const source = sourceRefToPath(row.source_ref ?? null, row.git_repo ?? null)
  const title = (() => {
    const trimmed = row.fact_text.trim().replace(/\s+/g, ' ')
    return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69)}...`
  })()
  return {
    metadata: {
      id: row.id,
      title,
      filePath: formatFactUri(row.id),
      ...(source ? { sourcePath: source.path } : {}),
      ...(source?.symbol ? { symbol: source.symbol } : {}),
      tags: [row.source_kind ?? 'fact', ...(row.git_repo ? [row.git_repo] : []), 'fact'],
    },
    content,
  }
}

async function extractClaims(
  llm: LLMProvider,
  question: string,
  draft: string,
  collector: RunCollector | undefined,
  stagePrefix: string
): Promise<ClaimPlan[]> {
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const response = await llm.call({
    messages: [
      {
        role: 'user',
        content: [
          'Extract the core factual claims from the draft answer that could be wrong.',
          'For each claim, write one short adversarial search query whose only goal is to find evidence that DISproves the claim.',
          `Return at most ${MAX_CLAIMS} claims. Prefer the most consequential claims.`,
          'Return ONLY JSON:',
          '{"claims":[{"claim":"<one sentence>","disproveQuery":"<search query>"}]}',
          '',
          `Question: ${question}`,
          '',
          `Draft answer:\n${draft.slice(0, 6000)}`,
        ].join('\n'),
      },
    ],
    temperature: 0,
    maxTokens: CLAIM_MAX_TOKENS,
    thinkingBudget: 0,
  })
  recordStage(
    collector,
    `${stagePrefix}:contradiction-claims`,
    llm,
    startedAt,
    startMs,
    response.usage
  )

  const parsed = extractJsonObject(response.text) as {
    claims?: Array<{ claim?: unknown; disproveQuery?: unknown }>
  }
  const claims = Array.isArray(parsed.claims) ? parsed.claims : []
  return claims
    .map(c => ({
      claim: typeof c.claim === 'string' ? c.claim.trim() : '',
      disproveQuery: typeof c.disproveQuery === 'string' ? c.disproveQuery.trim() : '',
    }))
    .filter(c => c.claim.length > 0 && c.disproveQuery.length > 0)
    .slice(0, MAX_CLAIMS)
}

function searchDisconfirming(
  baseDir: string,
  plans: ClaimPlan[],
  knownIds: Set<string>,
  searchFacts?: ContradictionSearchParams['searchFacts']
): { hits: ReadDocumentsResultItem[]; queries: string[] } {
  const hits: ReadDocumentsResultItem[] = []
  const queries: string[] = []
  const seen = new Set<string>(knownIds)

  const runSearch = (query: string, limit: number) => {
    if (searchFacts) return searchFacts(query, limit)
    const indexer = new SqliteKbIndexer({ dbPath: kbIndexDbPath(baseDir) })
    try {
      return indexer.searchFacts(query, limit)
    } finally {
      indexer.close()
    }
  }

  for (const plan of plans) {
    queries.push(plan.disproveQuery)
    const rows = runSearch(plan.disproveQuery, REQUERY_BUDGET * 3)
    let admitted = 0
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      hits.push(rowToItem(row))
      admitted++
      if (admitted >= REQUERY_BUDGET) break
    }
  }
  return { hits, queries }
}

async function filterContradictions(
  llm: LLMProvider,
  question: string,
  draft: string,
  plans: ClaimPlan[],
  candidates: ReadDocumentsResultItem[],
  collector: RunCollector | undefined,
  stagePrefix: string
): Promise<ReadDocumentsResultItem[]> {
  if (candidates.length === 0) return []

  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const candidateLines = candidates.map((c, i) => {
    const id = c.metadata?.id ?? `c-${i}`
    const body = (c.content ?? c.metadata?.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 240)
    return `${id}|${body}`
  })
  const claimLines = plans.map((p, i) => `${i + 1}. ${p.claim}`)

  const response = await llm.call({
    messages: [
      {
        role: 'user',
        content: [
          'You are checking whether candidate facts CONTRADICT the draft answer claims.',
          'Keep only facts that actually disprove or materially conflict with a claim.',
          'Drop facts that are merely related, supportive, or off-topic.',
          'Return ONLY JSON: {"contradict":["<id>",...]}',
          '',
          `Question: ${question}`,
          '',
          'Claims:',
          ...claimLines,
          '',
          `Draft (truncated):\n${draft.slice(0, 2000)}`,
          '',
          'Candidates (id|summary):',
          ...candidateLines,
        ].join('\n'),
      },
    ],
    temperature: 0,
    maxTokens: FILTER_MAX_TOKENS,
    thinkingBudget: 0,
  })
  recordStage(
    collector,
    `${stagePrefix}:contradiction-search`,
    llm,
    startedAt,
    startMs,
    response.usage
  )

  const parsed = extractJsonObject(response.text) as { contradict?: unknown }
  const keep = new Set(
    Array.isArray(parsed.contradict)
      ? parsed.contradict.filter((x): x is string => typeof x === 'string')
      : []
  )
  return candidates.filter(c => c.metadata?.id && keep.has(c.metadata.id))
}

async function reviseAnswer(
  llm: LLMProvider,
  question: string,
  draft: string,
  support: ReadDocumentsResultItem[],
  contradictions: ReadDocumentsResultItem[],
  collector: RunCollector | undefined,
  stagePrefix: string
): Promise<string> {
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const supportBlock = formatRetrievedFactsForLLM(support, {
    maxContentChars: MAX_FACT_CONTENT_CHARS,
  })
  const contradictBlock = formatRetrievedFactsForLLM(contradictions, {
    maxContentChars: MAX_FACT_CONTENT_CHARS,
  })
  const response = await llm.call({
    messages: [
      {
        role: 'user',
        content: [
          'Revise the draft answer using the original evidence AND the disconfirming evidence below.',
          'If a claim is contradicted, correct or qualify it. Do not invent facts.',
          'Keep the same structural rules as a normal KB answer: weave identifiers into prose; no Sources list.',
          'Return only the revised answer text.',
          '',
          `Question: ${question}`,
          '',
          `Draft answer:\n${draft}`,
          '',
          `Original evidence:\n${supportBlock}`,
          '',
          `Disconfirming evidence (treat as adversarial — prefer correcting the draft when these conflict):\n${contradictBlock}`,
        ].join('\n'),
      },
    ],
    temperature: 0,
    maxTokens: REVISE_MAX_TOKENS,
    thinkingBudget: 0,
  })
  recordStage(
    collector,
    `${stagePrefix}:contradiction-revise`,
    llm,
    startedAt,
    startMs,
    response.usage
  )
  return response.text.trim() || draft
}

function attachContradiction(
  result: IntentResult,
  contradiction: ContradictionTrace,
  mergedResults?: ReadDocumentsResultItem[],
  answer?: string
): IntentResult {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const supportCount =
    typeof contradiction.supportCount === 'number'
      ? contradiction.supportCount
      : Array.isArray(data.results)
        ? data.results.length
        : 0
  const contradictCount =
    typeof contradiction.contradictCount === 'number'
      ? contradiction.contradictCount
      : (contradiction.hitCount ?? 0)
  const confidenceBefore =
    typeof contradiction.confidenceBefore === 'number'
      ? contradiction.confidenceBefore
      : baseConfidenceFromResult(result)
  const confidenceAfter = confidenceFromSupportAndContradiction(
    confidenceBefore,
    supportCount,
    contradictCount
  )
  const enrichedTrace: ContradictionTrace = {
    ...contradiction,
    supportCount,
    contradictCount,
    confidenceBefore,
    confidenceAfter,
  }
  const next: ReadDocumentsResultData = {
    ...data,
    ...(mergedResults ? { results: mergedResults, total: mergedResults.length } : {}),
    ...(answer !== undefined ? { answer } : {}),
    retrieval: {
      ...(data.retrieval ?? {}),
      contradiction: enrichedTrace,
      confidence: confidenceAfter,
    },
  }
  return { ...result, confidence: confidenceAfter, data: next }
}

/**
 * Run post-draft contradiction search on a synthesized read_facts result.
 * No-ops (with `ran: false`) when there is no draft answer or empty evidence.
 */
export async function runContradictionSearch(
  params: ContradictionSearchParams
): Promise<IntentResult> {
  const { question, result, llm, baseDir, collector } = params
  const stagePrefix = params.intent ?? 'query_truth'

  if (!isReadFactsResult(result)) return result
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const draft = typeof data.answer === 'string' ? data.answer.trim() : ''
  const results = Array.isArray(data.results) ? data.results : []
  if (!draft || results.length === 0 || !question.trim()) {
    return attachContradiction(result, emptyTrace(false))
  }

  try {
    const plans = await extractClaims(llm, question, draft, collector, stagePrefix)
    if (plans.length === 0) {
      return attachContradiction(result, {
        ran: true,
        found: false,
        used: false,
        supportCount: results.length,
        contradictCount: 0,
      })
    }

    const knownIds = new Set(
      results.map(r => r.metadata?.id).filter((id): id is string => typeof id === 'string')
    )
    const { hits, queries } = searchDisconfirming(baseDir, plans, knownIds, params.searchFacts)

    const contradictions = await filterContradictions(
      llm,
      question,
      draft,
      plans,
      hits,
      collector,
      stagePrefix
    )

    if (contradictions.length === 0) {
      return attachContradiction(result, {
        ran: true,
        found: false,
        used: false,
        hitCount: 0,
        queries,
        factIds: [],
        supportCount: results.length,
        contradictCount: 0,
      })
    }

    const factIds = contradictions
      .map(c => c.metadata?.id)
      .filter((id): id is string => typeof id === 'string')
    const merged = [...results, ...contradictions]
    const revised = await reviseAnswer(
      llm,
      question,
      draft,
      results,
      contradictions,
      collector,
      stagePrefix
    )

    return attachContradiction(
      result,
      {
        ran: true,
        found: true,
        used: true,
        hitCount: contradictions.length,
        queries,
        factIds,
        supportCount: results.length,
        contradictCount: contradictions.length,
      },
      merged,
      revised
    )
  } catch {
    return attachContradiction(result, emptyTrace(true))
  }
}
