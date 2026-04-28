import { createHash } from 'node:crypto'
import type { QueryResponse, QueryResult } from './facts-document-reader'
import type { FactConceptRow, FactRow, SqliteKbIndexer } from './sqlite-kb-index'

interface FactsLoopOptions {
  query: string
  limit: number
  includeContent: boolean
  surface: 'query' | 'chat'
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
    const maxIterations = clampInt(process.env.KB_FACTS_QUERY_MAX_ITERS, 3, 1, 6)
    const maxGraphHops = clampInt(process.env.KB_FACTS_QUERY_MAX_HOPS, 2, 1, 3)
    const perIterationLimit = Math.max(input.limit, 8)
    const queryTokens = tokenizeQuery(input.query)
    let activeConcepts = queryTokens.slice(0, 8)
    const seenFactIds = new Set<string>()
    const scoredFacts = new Map<string, { row: FactRow; score: number }>()
    let graphHops = 0
    let sufficiency: SufficiencyDecision = { decision: 'not_answerable_yet', reason: 'insufficient-facts' }
    let clarificationQuestion: string | undefined

    for (let iter = 0; iter < maxIterations; iter++) {
      const lexicalRows = this.indexer.searchFacts(input.query, perIterationLimit)
      const conceptRows =
        activeConcepts.length > 0 ? this.indexer.searchFactsByConcepts(activeConcepts, perIterationLimit) : []
      const merged = mergeUniqueFacts([...lexicalRows, ...conceptRows], seenFactIds)
      if (merged.length === 0) break

      this.scoreIterationFacts(input.query, merged, scoredFacts)
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
      if (sufficiency.decision === 'answerable') {
        return this.buildResponse({
          input,
          scoredFacts,
          iterations: iter + 1,
          graphHops,
          sufficiencyReason: sufficiency.reason,
        })
      }

      if (iter < maxIterations - 1 && activeConcepts.length > 0 && graphHops < maxGraphHops) {
        activeConcepts = this.indexer.expandNeighborConcepts(activeConcepts, 1, 24)
        graphHops += 1
      }
    }

    if (input.surface === 'chat') {
      clarificationQuestion = buildClarificationQuestion(queryTokens, scoredFacts.size)
    }

    return this.buildResponse({
      input,
      scoredFacts,
      iterations: maxIterations,
      graphHops,
      sufficiencyReason: sufficiency.reason,
      clarificationQuestion,
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
    if (avgTop < 0.45) {
      return { decision: 'not_answerable_yet', reason: 'low-signal' }
    }
    if (input.conceptCoverage < 0.35) {
      return { decision: 'not_answerable_yet', reason: 'low-coverage' }
    }
    return { decision: 'answerable', reason: 'coverage-sufficient' }
  }

  private scoreIterationFacts(
    query: string,
    rows: FactRow[],
    scores: Map<string, { row: FactRow; score: number }>
  ): void {
    const queryTokens = tokenizeQuery(query)
    for (const row of rows) {
      const textTokens = tokenizeQuery(row.fact_text)
      const overlap = textTokens.filter(token => queryTokens.includes(token)).length
      const overlapScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0
      const recencyBias = row.source_kind === 'submit' ? 0.08 : 0
      const score = Math.min(1, overlapScore + recencyBias + row.confidence * 0.35)
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
    clarificationQuestion?: string
  }): QueryResponse {
    const ranked = [...input.scoredFacts.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, input.input.limit)
    const results: QueryResult[] = ranked.map(({ row }) => ({
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: `fact://${row.id}`,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, 'fact'],
        type: 'reference',
      },
      content: input.input.includeContent ? row.fact_text : undefined,
    }))
    const retrievalDetail = [
      'facts-loop',
      `iterations:${input.iterations}`,
      `graph_hops:${input.graphHops}`,
      `sufficiency:${input.sufficiencyReason}`,
    ].join(';')
    return {
      results,
      total: results.length,
      retrieval: {
        method: results.length > 0 ? 'hybrid' : 'lexical-fallback',
        detail: retrievalDetail,
        clarificationQuestion: input.clarificationQuestion,
      },
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

function buildClarificationQuestion(queryTokens: string[], evidenceCount: number): string {
  const missing = queryTokens.slice(0, 3).join(', ')
  if (evidenceCount === 0) {
    return `I need one concrete context to continue. Which area should I focus on first (${missing || 'scope, component, or workflow'})?`
  }
  return `I found partial evidence. Which missing facet matters most (${missing || 'scope, environment, or version'})?`
}

function tokenizeQuery(input: string): string[] {
  return [
    ...new Set(
      input
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
