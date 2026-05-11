import { createHash } from 'node:crypto'
import { inferQueryLaneWeights } from '../core/fact-taxonomy'
import { formatFactUri } from '../core/fact-uri'
import type { QueryResponse, QueryResult } from './facts-document-reader'
import type { FactConceptRow, FactRow, SqliteKbIndexer } from './sqlite-kb-index'

interface FactsLoopOptions {
  query: string
  limit: number
  includeContent: boolean
  surface: 'query' | 'chat'
  excludeIds?: Set<string>
}

interface SufficiencyDecision {
  decision: 'answerable' | 'not_answerable_yet'
  reason: string
}

const QUERY_STOP_WORDS = new Set([
  'what',
  'where',
  'when',
  'which',
  'who',
  'why',
  'how',
  'does',
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'about',
  'that',
  'this',
  'main',
  'are',
  'is',
  'was',
  'were',
])

export class FactsQueryResearchOrchestrator {
  constructor(private readonly indexer: SqliteKbIndexer) {}

  run(input: FactsLoopOptions): QueryResponse {
    const maxIterations = clampInt(process.env.KB_FACTS_QUERY_MAX_ITERS, 5, 1, 16)
    const maxGraphHops = clampInt(process.env.KB_FACTS_QUERY_MAX_HOPS, 3, 1, 5)
    const perIterationLimit = Math.max(input.limit, 15)
    const queryTokens = tokenizeQuery(input.query)
    const queryLaneWeights = inferQueryLaneWeights(input.query)
    let activeConcepts = queryTokens.slice(0, 8)
    const seenFactIds = new Set<string>(input.excludeIds ?? [])
    const scoredFacts = new Map<string, { row: FactRow; score: number }>()
    let graphHops = 0
    let sufficiency: SufficiencyDecision = {
      decision: 'not_answerable_yet',
      reason: 'insufficient-facts',
    }
    const loopTrace: string[] = []

    for (let iter = 0; iter < maxIterations; iter++) {
      const lexicalRows = this.indexer.searchFacts(input.query, perIterationLimit)
      const frontierConcepts = [...new Set([...activeConcepts, ...queryTokens])].slice(0, 40)
      const frontierRows =
        frontierConcepts.length > 0
          ? this.indexer.searchFactsByConceptFrontier(frontierConcepts, perIterationLimit)
          : []
      const conceptRows =
        activeConcepts.length > 0
          ? this.indexer.searchFactsByConcepts(activeConcepts, perIterationLimit)
          : []
      const merged = mergeUniqueFacts(
        [...lexicalRows, ...frontierRows, ...conceptRows],
        seenFactIds
      )
      const semanticScores = this.indexer.semanticFactScores(
        input.query,
        merged.map(row => row.id)
      )
      loopTrace.push(
        `i${iter + 1}:lex=${lexicalRows.length},frontier=${frontierRows.length},concept=${conceptRows.length},merged=${merged.length},sem=${semanticScores.size},c=${frontierConcepts.length}`
      )
      if (merged.length === 0) break

      this.scoreIterationFacts(
        input.query,
        merged,
        scoredFacts,
        new Set(frontierRows.map(row => row.id)),
        semanticScores,
        queryLaneWeights
      )
      const topRows = [...scoredFacts.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, perIterationLimit)
        .map(entry => entry.row)
      const factConcepts = this.indexer.listFactConcepts(topRows.map(row => row.id))
      const conceptCoverage = computeCoverage(queryTokens, factConcepts)
      sufficiency = this.assessSufficiency({
        scoredFacts,
        conceptCoverage,
      })
      if (sufficiency.decision === 'answerable' && graphHops >= 1) {
        return this.buildResponse({
          input,
          scoredFacts,
          iterations: iter + 1,
          graphHops,
          sufficiencyReason: sufficiency.reason,
          loopTrace,
          queryLaneWeights,
        })
      }

      if (iter < maxIterations - 1 && activeConcepts.length > 0 && graphHops < maxGraphHops) {
        activeConcepts = this.indexer.expandNeighborConcepts(activeConcepts, 1, 40)
        graphHops += 1
      }
    }

    return this.buildResponse({
      input,
      scoredFacts,
      iterations: maxIterations,
      graphHops,
      sufficiencyReason: sufficiency.reason,
      suggestRetrievalDeepen: input.surface === 'chat',
      loopTrace,
      queryLaneWeights,
    })
  }

  // Minimal prompt contract: single decision from deterministic signals.
  private assessSufficiency(input: {
    scoredFacts: Map<string, { row: FactRow; score: number }>
    conceptCoverage: number
  }): SufficiencyDecision {
    if (input.scoredFacts.size < 2) {
      return { decision: 'not_answerable_yet', reason: 'insufficient-facts' }
    }
    const top = [...input.scoredFacts.values()]
      .map(entry => entry.score)
      .sort((a, b) => b - a)
      .slice(0, 3)
    const avgTop = top.length > 0 ? top.reduce((sum, value) => sum + value, 0) / top.length : 0
    if (avgTop < 0.55) {
      return { decision: 'not_answerable_yet', reason: 'low-signal' }
    }
    if (input.conceptCoverage < 0.50) {
      return { decision: 'not_answerable_yet', reason: 'low-coverage' }
    }
    return { decision: 'answerable', reason: 'coverage-sufficient' }
  }

  private scoreIterationFacts(
    query: string,
    rows: FactRow[],
    scores: Map<string, { row: FactRow; score: number }>,
    frontierFactIds: Set<string>,
    semanticScores: Map<string, number>,
    queryLaneWeights: Partial<Record<string, number>>
  ): void {
    const queryTokens = tokenizeQuery(query)
    for (const row of rows) {
      const textTokens = tokenizeQuery(row.fact_text)
      const overlap = textTokens.filter(token => queryTokens.includes(token)).length
      const overlapScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0
      const recencyBias = row.source_kind === 'submit' ? 0.08 : 0
      const frontierBoost = frontierFactIds.has(row.id) ? 0.06 : 0
      const laneBoost = (queryLaneWeights[row.lane_id] ?? 0) * 0.12
      const semanticScore = semanticScores.get(row.id) ?? 0
      const score = Math.min(
        1,
        overlapScore * 0.45 +
          semanticScore * 0.35 +
          row.confidence * 0.2 +
          recencyBias +
          frontierBoost +
          laneBoost
      )
      const current = scores.get(row.id)
      if (!current || score > current.score) {
        scores.set(row.id, { row, score })
      }
    }
  }

  private buildResponse(input: {
    input: FactsLoopOptions
    scoredFacts: Map<string, { row: FactRow; score: number }>
    iterations: number
    graphHops: number
    sufficiencyReason: string
    suggestRetrievalDeepen?: boolean
    loopTrace?: string[]
    queryLaneWeights?: Partial<Record<string, number>>
  }): QueryResponse {
    const sorted = [...input.scoredFacts.values()].sort((a, b) => b.score - a.score)
    const limit = input.input.limit
    const MIN_PER_SOURCE = 2

    // Guarantee at least MIN_PER_SOURCE facts from each source_kind present in the pool,
    // then fill remaining slots by score.
    const reserved: typeof sorted = []
    const bySource = new Map<string, typeof sorted>()
    for (const entry of sorted) {
      const k = entry.row.source_kind
      if (!bySource.has(k)) bySource.set(k, [])
      bySource.get(k)?.push(entry)
    }
    const reservedIds = new Set<string>()
    for (const entries of bySource.values()) {
      for (const entry of entries.slice(0, MIN_PER_SOURCE)) {
        reserved.push(entry)
        reservedIds.add(entry.row.id)
      }
    }
    const remainder = sorted.filter(e => !reservedIds.has(e.row.id))
    const ranked = [...reserved, ...remainder].slice(0, limit)
    const results: QueryResult[] = ranked.map(({ row }) => ({
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: formatFactUri(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, row.lane_id, 'fact'],
        type: 'reference',
      },
      content: input.input.includeContent ? row.fact_text : undefined,
    }))
    const retrievalDetail = [
      'facts-loop',
      `iterations:${input.iterations}`,
      `graph_hops:${input.graphHops}`,
      `sufficiency:${input.sufficiencyReason}`,
      'semantic:on',
    ]
      .filter(Boolean)
      .join(';')
    const traceDetail = [
      input.queryLaneWeights && Object.keys(input.queryLaneWeights).length > 0
        ? `lanes:${Object.keys(input.queryLaneWeights).join(',')}`
        : null,
      input.loopTrace?.length ? `trace:${input.loopTrace.join('|')}` : null,
    ]
      .filter(Boolean)
      .join(';')
    const retrieval: QueryResponse['retrieval'] = {
      method: results.length > 0 ? 'hybrid' : 'lexical-fallback',
      detail: retrievalDetail,
      ...(traceDetail ? { traceDetail } : {}),
    }
    if (input.suggestRetrievalDeepen === true) {
      retrieval.suggestRetrievalDeepen = true
    }
    return {
      results,
      total: results.length,
      retrieval,
    }
  }
}

function mergeUniqueFacts(rows: FactRow[], seenFactIds: Set<string>): FactRow[] {
  const merged: FactRow[] = []
  for (const row of rows) {
    if (seenFactIds.has(row.id)) continue
    seenFactIds.add(row.id)
    merged.push(row)
  }
  return merged
}

function computeCoverage(queryTokens: string[], concepts: FactConceptRow[]): number {
  if (queryTokens.length === 0) return 0
  const conceptSet = new Set(concepts.map(concept => concept.concept_id))
  const covered = queryTokens.filter(token => conceptSet.has(token)).length
  return covered / queryTokens.length
}

function tokenizeQuery(input: string): string[] {
  const expanded = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return [
    ...new Set(
      expanded
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !QUERY_STOP_WORDS.has(token))
    ),
  ].slice(0, 12)
}

function summarizeFactTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 72) return trimmed
  return `${trimmed.slice(0, 69)}...`
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function buildFactsLoopFingerprint(query: string): string {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex')
}
