import { createHash } from 'node:crypto'
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

type LoopStopReason =
  | 'answerable_plateau'
  | 'frontier_exhausted'
  | 'budget_exhausted'
  | 'weak_evidence_after_exhaustion'

interface LoopCheckpoint {
  stage: string
  status: 'continue' | 'stop'
  nextAction: string
  confidence: number
}

interface LoopMetrics {
  uniqueFacts: number
  conceptCoverage: number
  avgTop: number
  queryTokenCoverage: number
  frontierConcepts: number
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
    const maxIterations = clampInt(process.env.KB_FACTS_QUERY_MAX_ITERS, 24, 1, 24)
    const maxGraphHops = clampInt(process.env.KB_FACTS_QUERY_MAX_HOPS, 20, 1, 40)
    const hardResultLimit = clampInt(process.env.KB_FACTS_QUERY_MAX_RESULTS, 60, 10, 200)
    const queryTokens = tokenizeQuery(input.query)
    const rankedCategories = this.indexer.inferCategoriesForQuery(input.query, 4)
    let activeCategoryIds = rankedCategories.slice(0, 2).map(category => category.categoryId)
    let activeConcepts = queryTokens.slice(0, 8)
    let activeConceptBudget = 40
    let retrievalLimit = Math.max(input.limit, 5)
    const seenFactIds = new Set<string>(input.excludeIds ?? [])
    const scoredFacts = new Map<string, { row: FactRow; score: number }>()
    let graphHops = 0
    let sufficiency: SufficiencyDecision = {
      decision: 'not_answerable_yet',
      reason: 'insufficient-facts',
    }
    const loopTrace: string[] = []
    const checkpoints: LoopCheckpoint[] = []
    let plateauCount = 0
    let stopReason: LoopStopReason = 'budget_exhausted'
    let previousMetrics: LoopMetrics | undefined
    let iterationsRun = 0

    for (let iter = 0; iter < maxIterations; iter++) {
      iterationsRun = iter + 1
      const perIterationLimit = Math.max(retrievalLimit, 15)
      const lexicalRows =
        activeCategoryIds.length > 0
          ? this.indexer.searchFactsInCategories(input.query, activeCategoryIds, perIterationLimit)
          : this.indexer.searchFacts(input.query, perIterationLimit)
      const frontierConcepts = [...new Set([...activeConcepts, ...queryTokens])].slice(
        0,
        activeConceptBudget
      )
      const frontierRows =
        frontierConcepts.length > 0
          ? activeCategoryIds.length > 0
            ? this.indexer.searchFactsByConceptFrontierInCategories(
                frontierConcepts,
                activeCategoryIds,
                perIterationLimit
              )
            : this.indexer.searchFactsByConceptFrontier(frontierConcepts, perIterationLimit)
          : []
      const conceptRows =
        activeConcepts.length > 0
          ? activeCategoryIds.length > 0
            ? this.indexer.searchFactsByConceptsInCategories(
                activeConcepts,
                activeCategoryIds,
                perIterationLimit
              )
            : this.indexer.searchFactsByConcepts(activeConcepts, perIterationLimit)
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
        `i${iter + 1}:limit=${perIterationLimit},lex=${lexicalRows.length},frontier=${frontierRows.length},concept=${conceptRows.length},merged=${merged.length},sem=${semanticScores.size},c=${frontierConcepts.length},categories=${activeCategoryIds.length},hops=${graphHops}`
      )
      if (merged.length === 0) {
        const exhaustedMetrics =
          previousMetrics ??
          ({
            uniqueFacts: scoredFacts.size,
            conceptCoverage: 0,
            avgTop: averageTopScores(scoredFacts),
            queryTokenCoverage: queryTokens.length,
            frontierConcepts: frontierConcepts.length,
          } satisfies LoopMetrics)
        const exhaustedConfidence =
          scoredFacts.size > 0 ? computeCheckpointConfidence(exhaustedMetrics) : 0
        checkpoints.push({
          stage: `pass_${iter + 1}`,
          status: 'stop',
          nextAction: 'frontier_exhausted',
          confidence: exhaustedConfidence,
        })
        stopReason =
          sufficiency.decision === 'answerable'
            ? 'frontier_exhausted'
            : scoredFacts.size > 0
              ? 'weak_evidence_after_exhaustion'
              : 'weak_evidence_after_exhaustion'
        break
      }

      this.scoreIterationFacts(
        input.query,
        merged,
        scoredFacts,
        new Set(frontierRows.map(row => row.id)),
        semanticScores,
        activeCategoryIds
      )
      const topRows = [...scoredFacts.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, perIterationLimit)
        .map(entry => entry.row)
      const factConcepts = this.indexer.listFactConcepts(topRows.map(row => row.id))
      const conceptCoverage = computeCoverage(queryTokens, factConcepts)
      const avgTop = averageTopScores(scoredFacts)
      const metrics: LoopMetrics = {
        uniqueFacts: scoredFacts.size,
        conceptCoverage,
        avgTop,
        queryTokenCoverage: queryTokens.length,
        frontierConcepts: frontierConcepts.length,
      }
      sufficiency = this.assessSufficiency({
        scoredFacts,
        conceptCoverage,
      })
      const confidence = computeCheckpointConfidence(metrics)
      const hasMeaningfulGain = hasMeaningfulProgress(previousMetrics, metrics)
      plateauCount = hasMeaningfulGain ? 0 : plateauCount + 1

      let nextAction = 'continue'
      let status: LoopCheckpoint['status'] = 'continue'

      if (sufficiency.decision === 'answerable' && plateauCount >= 2) {
        status = 'stop'
        nextAction = 'return_answerable_plateau'
        stopReason = 'answerable_plateau'
      }

      const shouldGrowLimit = shouldIncreaseRetrievalLimit({
        currentLimit: retrievalLimit,
        hardResultLimit,
        metrics,
        sufficiency,
      })
      const nextCategoryIds = shouldWidenCategories({
        activeCategoryIds,
        rankedCategories,
        sufficiency,
      })
      const expandedConcepts =
        graphHops < maxGraphHops && activeConcepts.length > 0
          ? this.indexer.expandNeighborConcepts(activeConcepts, 1, activeConceptBudget + 8)
          : activeConcepts
      const newNeighborConcepts = expandedConcepts.filter(concept => !activeConcepts.includes(concept))
      const canExpandGraph = newNeighborConcepts.length > 0 && graphHops < maxGraphHops

      if (status !== 'stop') {
        const frontierExhausted =
          !shouldGrowLimit &&
          nextCategoryIds.length === activeCategoryIds.length &&
          !canExpandGraph &&
          plateauCount >= 1
        if (frontierExhausted) {
          status = 'stop'
          nextAction = 'frontier_exhausted'
          stopReason =
            sufficiency.decision === 'answerable'
              ? 'frontier_exhausted'
              : 'weak_evidence_after_exhaustion'
        } else if (plateauCount >= 2) {
          status = 'stop'
          nextAction = 'plateau'
          stopReason =
            sufficiency.decision === 'answerable'
              ? 'answerable_plateau'
              : 'weak_evidence_after_exhaustion'
        }
      }

      checkpoints.push({
        stage: `pass_${iter + 1}`,
        status,
        nextAction,
        confidence,
      })

      if (status === 'stop') {
        break
      }

      if (shouldGrowLimit) {
        retrievalLimit = nextRetrievalLimit(retrievalLimit, hardResultLimit)
      }
      if (nextCategoryIds.length > activeCategoryIds.length) {
        activeCategoryIds = nextCategoryIds
      }
      if (canExpandGraph) {
        graphHops += 1
        activeConceptBudget = Math.min(activeConceptBudget + 8, 96)
        activeConcepts = expandedConcepts.slice(0, activeConceptBudget)
      }
      previousMetrics = metrics
    }

    return this.buildResponse({
      input,
      scoredFacts,
      iterations: iterationsRun,
      graphHops,
      sufficiencyReason: stopReason,
      loopTrace,
      rankedCategories,
      checkpoints,
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
    activeCategoryIds: string[]
  ): void {
    const queryTokens = tokenizeQuery(query)
    const categoryIds = this.indexer.getFactCategoryIdsForFacts(rows.map(row => row.id))
    for (const row of rows) {
      const textTokens = tokenizeQuery(row.fact_text)
      const overlap = textTokens.filter(token => queryTokens.includes(token)).length
      const overlapScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0
      const recencyBias = 0
      const frontierBoost = frontierFactIds.has(row.id) ? 0.06 : 0
      const categories = categoryIds.get(row.id) ?? []
      const categoryBoost =
        activeCategoryIds.length > 0 && categories.some(category => activeCategoryIds.includes(category))
          ? Math.min(0.18, categories.filter(category => activeCategoryIds.includes(category)).length * 0.09)
          : 0
      const semanticScore = semanticScores.get(row.id) ?? 0
      const score = Math.min(
        1,
        overlapScore * 0.45 +
          semanticScore * 0.35 +
          row.confidence * 0.2 +
          recencyBias +
          frontierBoost +
          categoryBoost
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
    loopTrace?: string[]
    rankedCategories?: Array<{ categoryId: string; name: string; score: number }>
    checkpoints?: LoopCheckpoint[]
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
    const categoryNames = this.indexer.getFactCategoryNamesForFacts(ranked.map(entry => entry.row.id))
    const results: QueryResult[] = ranked.map(({ row }) => ({
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: formatFactUri(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, ...(categoryNames.get(row.id) ?? []), 'fact'],
        type: 'reference',
      },
      content: input.input.includeContent ? row.fact_text : undefined,
    }))
    const retrievalDetail = [
      'facts-loop',
      `passes:${input.iterations}`,
      `graph_hops:${input.graphHops}`,
      `stop:${input.sufficiencyReason}`,
      'semantic:on',
    ]
      .filter(Boolean)
      .join(';')
    const traceDetail = [
      input.rankedCategories && input.rankedCategories.length > 0
        ? `categories:${input.rankedCategories.map(category => category.name).join(',')}`
        : null,
      input.loopTrace?.length ? `trace:${input.loopTrace.join('|')}` : null,
    ]
      .filter(Boolean)
      .join(';')
    const retrieval: QueryResponse['retrieval'] = {
      method: results.length > 0 ? 'hybrid' : 'lexical-fallback',
      detail: retrievalDetail,
      ...(input.checkpoints && input.checkpoints.length > 0
        ? { checkpoints: input.checkpoints }
        : {}),
      ...(traceDetail ? { traceDetail } : {}),
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

function averageTopScores(scores: Map<string, { row: FactRow; score: number }>): number {
  const top = [...scores.values()]
    .map(entry => entry.score)
    .sort((a, b) => b - a)
    .slice(0, 3)
  return top.length > 0 ? top.reduce((sum, value) => sum + value, 0) / top.length : 0
}

function computeCheckpointConfidence(metrics: LoopMetrics): number {
  const blended = metrics.avgTop * 0.75 + metrics.conceptCoverage * 0.25
  const floorFromStrongSingleFact =
    metrics.uniqueFacts > 0 && metrics.avgTop >= 0.65 ? Math.min(0.6, metrics.avgTop) : 0
  return clampFloat(Math.max(blended, floorFromStrongSingleFact), 0, 1)
}

function hasMeaningfulProgress(previous: LoopMetrics | undefined, current: LoopMetrics): boolean {
  if (!previous) return true
  if (current.uniqueFacts >= previous.uniqueFacts + 2) return true
  if (current.conceptCoverage >= previous.conceptCoverage + 0.08) return true
  if (current.avgTop >= previous.avgTop + 0.04) return true
  if (current.frontierConcepts > previous.frontierConcepts) return true
  return false
}

function shouldIncreaseRetrievalLimit(input: {
  currentLimit: number
  hardResultLimit: number
  metrics: LoopMetrics
  sufficiency: SufficiencyDecision
}): boolean {
  if (input.currentLimit >= input.hardResultLimit) return false
  if (input.metrics.uniqueFacts <= input.currentLimit + 2) return true
  if (input.sufficiency.decision !== 'answerable') return true
  if (input.metrics.conceptCoverage < 0.7) return true
  return input.metrics.avgTop < 0.7
}

function nextRetrievalLimit(currentLimit: number, hardResultLimit: number): number {
  if (currentLimit >= hardResultLimit) return hardResultLimit
  const step = currentLimit < 10 ? 5 : Math.max(5, Math.ceil(currentLimit * 0.5))
  return Math.min(hardResultLimit, currentLimit + step)
}

function shouldWidenCategories(input: {
  activeCategoryIds: string[]
  rankedCategories: Array<{ categoryId: string; name: string; score: number }>
  sufficiency: SufficiencyDecision
}): string[] {
  if (input.sufficiency.decision === 'answerable') return input.activeCategoryIds
  if (input.activeCategoryIds.length >= input.rankedCategories.length) return input.activeCategoryIds
  return input.rankedCategories
    .slice(0, input.activeCategoryIds.length + 1)
    .map(category => category.categoryId)
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function buildFactsLoopFingerprint(query: string): string {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex')
}
