import { createHash } from 'node:crypto'
import { formatFactUri, sourceRefToPath } from '../core/fact-uri'
import type { QueryResponse, QueryResult } from './facts-document-reader'
import { type FactsSufficiencyJudge, shouldCallJudge } from './facts-sufficiency-judge'
import { type QueryTraceLane, isQueryTraceEnabled, tracedFactFromRow } from './query-trace'
import type { FactConceptRow, FactRow, SqliteKbIndexer } from './sqlite-kb-index'

export const DEFAULT_FACT_LIMIT = 500
/** Minimum score for remainder facts (excludes near-zero-signal tail; reserved entries bypass this). */
const MIN_FACT_SCORE = 0.20

interface FactsLoopOptions {
  query: string
  includeContent: boolean
  surface: 'query' | 'chat'
  excludeIds?: Set<string>
  /** H5 ablation: score overlap+semantic against this (the raw question) instead of `query`. */
  scoringQuery?: string
}

interface SufficiencyDecision {
  decision: 'answerable' | 'not_answerable_yet'
  reason: string
}

type LoopStopReason =
  | 'answerable_plateau'
  | 'llm_judge_answerable'
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
  relevantFacts: number
  conceptCoverage: number
  avgTop: number
  queryTokenCoverage: number
  frontierConcepts: number
  activePonds: number
}

interface ExplorationPond {
  id: number
  query: string
  frontierFactIds: string[]
  hops: number
  exhausted: boolean
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

const ABSOLUTE_MAX_ITERATIONS = 512
const ABSOLUTE_MAX_PONDS = 32

export class FactsQueryResearchOrchestrator {
  constructor(
    private readonly indexer: SqliteKbIndexer,
    private readonly options?: { judge?: FactsSufficiencyJudge }
  ) {}

  async run(input: FactsLoopOptions): Promise<QueryResponse> {
    const maxIterations = clampLimitInt(process.env.KB_FACTS_QUERY_MAX_ITERS, 24, 1, 24)
    const maxGraphHops = clampLimitInt(process.env.KB_FACTS_QUERY_MAX_HOPS, 20, 1, 40)
    const maxPonds = clampLimitInt(process.env.KB_FACTS_QUERY_MAX_PONDS, 6, 2, 12)
    const perIterationLimit = 50
    const traceEnabled = isQueryTraceEnabled()
    // H5 ablation: discovery (FTS / ponds / frontier) still uses the (expanded) `input.query`,
    // but overlap + semantic *scoring* is computed against `scoringQuery` (the raw question).
    const scoringQuery = input.scoringQuery?.trim() || input.query
    const queryTokens = tokenizeQuery(input.query)
    // Repo-pool retrieval: facts are organised by the git repo they came from (not by
    // categories). We seed on the repo the first lexical hit lands in, then order results so
    // that repo's pool is exhausted before walking the cross-repo edge tree to sibling repos.
    const crossRepoLinks = this.indexer.listCrossRepoLinks()
    // Repo-pool ordering only kicks in for genuinely multi-repo bases; single-repo (and all
    // legacy) bases behave exactly as before — no repo boost, no repo-distance sort.
    const multiRepo = crossRepoLinks.length > 0
    let primaryRepo: string | null = null
    let repoDistance = new Map<string, number>()
    let activeConcepts = queryTokens.slice(0, 8)
    let activeConceptBudget = 40
    const seenFactIds = new Set<string>(input.excludeIds ?? [])
    const scoredFacts = new Map<string, { row: FactRow; score: number }>()
    const primaryLexicalAnchors = new Set<string>()
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
    const ponds = buildExplorationPonds(input.query, queryTokens, maxPonds)
    seedPondFrontiers(this.indexer, ponds)
    let pondCursor = 0

    for (let iter = 0; isUnlimited(maxIterations) || iter < maxIterations; iter++) {
      if (isUnlimited(maxIterations) && iter >= ABSOLUTE_MAX_ITERATIONS) {
        stopReason = 'budget_exhausted'
        loopTrace.push(`i${iter + 1}:absolute_iter_cap`)
        break
      }
      iterationsRun = iter + 1
      const activePondSelection = selectNextPond(ponds, pondCursor)
      if (!activePondSelection) {
        stopReason = scoredFacts.size > 0 ? 'weak_evidence_after_exhaustion' : 'frontier_exhausted'
        break
      }
      const { pond: activePond, index: activePondIndex } = activePondSelection
      pondCursor = (activePondIndex + 1) % ponds.length

      const edgeNeighborRows =
        withinLimit(graphHops, maxGraphHops) && activePond.frontierFactIds.length > 0
          ? this.indexer.getFactNeighbors(activePond.frontierFactIds, seenFactIds, perIterationLimit)
          : []
      if (edgeNeighborRows.length > 0) {
        graphHops += 1
        activePond.hops += 1
      }
      const lexicalRows = this.indexer.searchFacts(input.query, perIterationLimit)
      if (iter === 0) {
        for (const row of lexicalRows.slice(0, 10)) {
          primaryLexicalAnchors.add(row.id)
        }
        // The "landed" repo is where the strongest lexical hit lives; everything is ordered
        // outward from it along the cross-repo edge tree.
        if (multiRepo) {
          primaryRepo = lexicalRows.find(row => row.git_repo)?.git_repo ?? null
          repoDistance = computeRepoDistances(primaryRepo, crossRepoLinks)
        }
      }
      const pondLexicalRows =
        activePond.query.trim().toLowerCase() === input.query.trim().toLowerCase()
          ? []
          : this.indexer.searchFacts(activePond.query, perIterationLimit)
      const frontierConcepts = [...new Set([...activeConcepts, ...queryTokens])].slice(
        0,
        activeConceptBudget
      )
      const frontierRows =
        frontierConcepts.length > 0
          ? this.indexer.searchFactsByConceptFrontier(frontierConcepts, perIterationLimit)
          : []
      const conceptRows =
        activeConcepts.length > 0
          ? this.indexer.searchFactsByConcepts(activeConcepts, perIterationLimit)
          : []
      const merged = mergeUniqueFacts(
        [...lexicalRows, ...pondLexicalRows, ...edgeNeighborRows, ...frontierRows, ...conceptRows],
        seenFactIds
      )
      const semanticScores = this.indexer.semanticFactScores(
        scoringQuery,
        merged.map(row => row.id)
      )
      const activePonds = ponds.filter(pond => !pond.exhausted).length
      loopTrace.push(
        `i${iter + 1}:limit=${perIterationLimit},lex=${lexicalRows.length},pond=${activePond.id}/${ponds.length}:${summarizePondQuery(activePond.query)},plex=${pondLexicalRows.length},edges=${edgeNeighborRows.length},frontier=${frontierRows.length},concept=${conceptRows.length},merged=${merged.length},sem=${semanticScores.size},c=${frontierConcepts.length},repo=${primaryRepo ?? 'n/a'},ponds=${activePonds},hops=${graphHops}`
      )
      if (merged.length === 0) {
        markPondExhaustedIfStalled(activePond, edgeNeighborRows, pondLexicalRows, seenFactIds)
        const nextPond = selectNextPond(ponds, pondCursor)
        if (nextPond) {
          loopTrace.push(`i${iter + 1}:pond_skip:${activePond.id}`)
          continue
        }
        const exhaustedMetrics =
          previousMetrics ??
          ({
            uniqueFacts: scoredFacts.size,
            relevantFacts: [...scoredFacts.values()].filter(e => e.score >= 0.5).length,
            conceptCoverage: 0,
            avgTop: averageTopScores(scoredFacts),
            queryTokenCoverage: queryTokens.length,
            frontierConcepts: frontierConcepts.length,
            activePonds: ponds.filter(pond => !pond.exhausted).length,
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

      const edgeNeighborIds = new Set(edgeNeighborRows.map(row => row.id))
      const frontierMaxScore =
        activePond.frontierFactIds.length > 0
          ? Math.max(...activePond.frontierFactIds.map(id => scoredFacts.get(id)?.score ?? 0))
          : 0
      this.scoreIterationFacts(
        scoringQuery,
        merged,
        scoredFacts,
        new Set([
          ...frontierRows.map(row => row.id),
          ...pondLexicalRows.map(row => row.id),
          ...edgeNeighborRows.map(row => row.id),
        ]),
        edgeNeighborIds,
        frontierMaxScore,
        semanticScores,
        repoDistance,
        primaryLexicalAnchors
      )
      const topRows = [...scoredFacts.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, perIterationLimit)
        .map(entry => entry.row)
      const factConcepts = this.indexer.listFactConcepts(topRows.map(row => row.id))
      const conceptCoverage = computeCoverage(queryTokens, factConcepts)
      const avgTop = averageTopScores(scoredFacts)
      const relevantFacts = [...scoredFacts.values()].filter(e => e.score >= 0.5).length
      const metrics: LoopMetrics = {
        uniqueFacts: scoredFacts.size,
        relevantFacts,
        conceptCoverage,
        avgTop,
        queryTokenCoverage: queryTokens.length,
        frontierConcepts: frontierConcepts.length,
        activePonds,
      }
      sufficiency = this.assessSufficiency({ scoredFacts, conceptCoverage })
      const confidence = computeCheckpointConfidence(metrics)
      const hasMeaningfulGain = hasMeaningfulProgress(previousMetrics, metrics)
      plateauCount = hasMeaningfulGain ? 0 : plateauCount + 1

      let nextAction = 'continue'
      let status: LoopCheckpoint['status'] = 'continue'

      if (sufficiency.decision === 'answerable') {
        status = 'stop'
        nextAction = 'return_answerable'
        stopReason = 'answerable_plateau'
      } else if (this.options?.judge && shouldCallJudge(iter, relevantFacts)) {
        const judgeInput = [...scoredFacts.values()]
          .filter(e => e.score >= 0.5)
          .sort((a, b) => b.score - a.score)
          .slice(0, 40)
          .map(e => ({ id: e.row.id, text: e.row.fact_text }))
        const verdict = await this.options.judge(input.query, judgeInput)
        if (verdict === 'answerable') {
          status = 'stop'
          nextAction = 'llm_judge_answerable'
          stopReason = 'llm_judge_answerable'
        }
      }

      const triedEdgeWalk = activePond.frontierFactIds.length > 0
      const pondEdgeStalled = triedEdgeWalk && edgeNeighborRows.length === 0
      if (pondEdgeStalled && pondLexicalRows.every(row => seenFactIds.has(row.id))) {
        activePond.exhausted = true
      } else {
        activePond.frontierFactIds = pickPondFrontier({
          edgeNeighborRows,
          pondLexicalRows,
          topRows,
          limit: Math.min(12, perIterationLimit),
        })
      }
      const anyPondCanWalk =
        withinLimit(graphHops, maxGraphHops) &&
        ponds.some(pond => !pond.exhausted && pond.frontierFactIds.length > 0)
      const canExpandEdges = anyPondCanWalk
      const expandedConcepts =
        activeConcepts.length > 0
          ? this.indexer.expandNeighborConcepts(activeConcepts, 1, activeConceptBudget + 8)
          : activeConcepts
      const newNeighborConcepts = expandedConcepts.filter(concept => !activeConcepts.includes(concept))
      const canExpandConcepts = newNeighborConcepts.length > 0
      const canExpandGraph = canExpandEdges || canExpandConcepts

      if (status !== 'stop') {
        const frontierExhausted = !canExpandGraph && plateauCount >= 1
        if (frontierExhausted) {
          status = 'stop'
          nextAction = 'frontier_exhausted'
          stopReason =
            sufficiency.decision === 'answerable'
              ? 'frontier_exhausted'
              : 'weak_evidence_after_exhaustion'
        } else if (plateauCount >= 3) {
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

      if (canExpandConcepts) {
        activeConceptBudget = Math.min(activeConceptBudget + 8, 96)
        activeConcepts = expandedConcepts.slice(0, activeConceptBudget)
        maybeSpawnConceptPond(ponds, newNeighborConcepts, maxPonds, this.indexer)
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
      primaryRepo,
      repoDistance,
      checkpoints,
      primaryLexicalAnchors,
      pondCount: ponds.length,
      traceEnabled,
      knobs: { maxIterations, maxGraphHops, maxPonds, perIterationLimit },
    })
  }

  // Minimal prompt contract: single decision from deterministic signals.
  private assessSufficiency(input: {
    scoredFacts: Map<string, { row: FactRow; score: number }>
    conceptCoverage?: number
  }): SufficiencyDecision {
    const relevantFacts = [...input.scoredFacts.values()].filter(entry => entry.score >= 0.50)
    if (relevantFacts.length < 20) {
      return { decision: 'not_answerable_yet', reason: 'insufficient-facts' }
    }
    if ((input.conceptCoverage ?? 0) < 0.3 && relevantFacts.length < 30) {
      return { decision: 'not_answerable_yet', reason: 'low-concept-coverage' }
    }
    return { decision: 'answerable', reason: 'coverage-sufficient' }
  }

  private scoreIterationFacts(
    query: string,
    rows: FactRow[],
    scores: Map<string, { row: FactRow; score: number }>,
    frontierFactIds: Set<string>,
    edgeNeighborIds: Set<string>,
    frontierMaxScore: number,
    semanticScores: Map<string, number>,
    repoDistance: Map<string, number>,
    primaryLexicalAnchors: Set<string>
  ): void {
    const queryTokens = tokenizeQuery(query)
    for (const row of rows) {
      const textTokens = tokenizeQuery(row.fact_text)
      const overlap = textTokens.filter(token => queryTokens.includes(token)).length
      const overlapScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0
      const frontierBoost = frontierFactIds.has(row.id) ? 0.06 : 0
      const anchorBoost = primaryLexicalAnchors.has(row.id) ? 0.1 : 0
      // Repo-pool boost: facts from the landed repo rank highest; sibling repos decay with
      // their distance along the cross-repo edge tree.
      const repoBoost = repoBoostForDistance(repoDistanceFor(row.git_repo, repoDistance))
      const qualityPenalty = retrievalFactPenalty(row)

      // Code facts: swap SHA256 semantic weight for graph proximity score.
      // Identifier-only matches score ~0.25-0.39 (below "relevant" threshold of 0.5).
      // Facts discovered via graph traversal from a high-scoring parent score 0.55+.
      const isCodeFact = row.source_kind === 'import_code'
      let score: number
      if (isCodeFact) {
        const graphProximityScore = edgeNeighborIds.has(row.id) ? frontierMaxScore : 0
        score = Math.min(
          1,
          overlapScore * 0.20 +
            graphProximityScore * 0.60 +
            row.confidence * 0.20 +
            frontierBoost +
            anchorBoost +
            repoBoost -
            qualityPenalty
        )
      } else {
        const semanticScore = semanticScores.get(row.id) ?? 0
        score = Math.min(
          1,
          overlapScore * 0.45 +
            semanticScore * 0.35 +
            row.confidence * 0.20 +
            frontierBoost +
            anchorBoost +
            repoBoost -
            qualityPenalty
        )
      }

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
    primaryRepo?: string | null
    repoDistance?: Map<string, number>
    checkpoints?: LoopCheckpoint[]
    primaryLexicalAnchors?: Set<string>
    pondCount?: number
    traceEnabled?: boolean
    knobs?: QueryTraceLane['knobs']
  }): QueryResponse {
    const repoDistance = input.repoDistance ?? new Map<string, number>()
    // Order primarily by repo pool (landed repo first, then outward along the tree), and by
    // score within each pool — so a query that lands in "auth" exhausts auth before others.
    const sorted = [...input.scoredFacts.values()]
      .filter(entry => !isExcludedRetrievalFact(entry.row))
      .sort((a, b) => {
        const da = repoDistanceFor(a.row.git_repo, repoDistance)
        const db = repoDistanceFor(b.row.git_repo, repoDistance)
        if (da !== db) return da - db
        return b.score - a.score
      })
    const MIN_PER_SOURCE = 2
    const ANCHOR_SLOTS = 3

    const anchorEntries = [...(input.primaryLexicalAnchors ?? [])]
      .map(id => input.scoredFacts.get(id))
      .filter((entry): entry is { row: FactRow; score: number } => {
        if (!entry) return false
        return !isExcludedRetrievalFact(entry.row)
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, ANCHOR_SLOTS)

    // Guarantee at least MIN_PER_SOURCE facts from each source_kind present in the pool,
    // then fill remaining slots by score.
    const reserved: typeof sorted = [...anchorEntries]
    const bySource = new Map<string, typeof sorted>()
    for (const entry of sorted) {
      const k = entry.row.source_kind
      if (!bySource.has(k)) bySource.set(k, [])
      bySource.get(k)?.push(entry)
    }
    const reservedIds = new Set<string>(anchorEntries.map(entry => entry.row.id))
    for (const entries of bySource.values()) {
      for (const entry of entries.slice(0, MIN_PER_SOURCE)) {
        if (reservedIds.has(entry.row.id)) continue
        reserved.push(entry)
        reservedIds.add(entry.row.id)
      }
    }
    const filteredRemainder = sorted
      .filter(e => !reservedIds.has(e.row.id) && e.score >= MIN_FACT_SCORE)
    const ranked = dedupeRankedFacts([...reserved, ...filteredRemainder])
    const results: QueryResult[] = ranked.map(({ row }) => {
      const source = sourceRefToPath(row.source_ref, row.git_repo)
      return {
        metadata: {
          id: row.id,
          title: summarizeFactTitle(row.fact_text),
          filePath: formatFactUri(row.id),
          ...(source ? { sourcePath: source.path } : {}),
          ...(source?.symbol ? { symbol: source.symbol } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          tags: [row.source_kind, ...(row.git_repo ? [row.git_repo] : []), 'fact'],
          type: 'reference',
        },
        content: input.input.includeContent ? row.fact_text : undefined,
      }
    })
    const retrievalDetail = [
      'facts-loop',
      `passes:${input.iterations}`,
      `graph_hops:${input.graphHops}`,
      input.pondCount ? `ponds:${input.pondCount}` : null,
      `stop:${input.sufficiencyReason}`,
      `facts:${results.length}`,
      'semantic:on',
    ]
      .filter(Boolean)
      .join(';')
    const traceDetail = [
      input.primaryRepo ? `repo:${input.primaryRepo}` : null,
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
    // Opt-in deep trace: dump the *whole* scored pool (not just what shipped), plus the
    // per-pass decisions, so an offline replay can see exactly what the walk discovered and
    // what it cut. Never propagated into synthesis — the reader strips it after writing.
    let trace: QueryTraceLane | undefined
    if (input.traceEnabled && input.knobs) {
      const returnedIds = new Set(results.map(result => result.metadata.id))
      const discovered = [...input.scoredFacts.values()]
        .sort((a, b) => b.score - a.score)
        .map(entry => tracedFactFromRow(entry.row, entry.score))
      const droppedBelowFloor = [...input.scoredFacts.values()]
        .filter(entry => !returnedIds.has(entry.row.id) && entry.score < MIN_FACT_SCORE)
        .sort((a, b) => b.score - a.score)
        .map(entry => tracedFactFromRow(entry.row, entry.score))
      trace = {
        query: input.input.query,
        knobs: input.knobs,
        iterations: input.iterations,
        graphHops: input.graphHops,
        pondCount: input.pondCount ?? 0,
        stopReason: input.sufficiencyReason,
        passTrace: input.loopTrace ?? [],
        checkpoints: (input.checkpoints ?? []).map(checkpoint => ({
          stage: checkpoint.stage,
          status: checkpoint.status,
          nextAction: checkpoint.nextAction,
          confidence: checkpoint.confidence,
        })),
        discovered,
        returned: [...returnedIds],
        droppedBelowFloor,
      }
    }
    return {
      results,
      total: results.length,
      retrieval,
      ...(trace ? { trace } : {}),
    }
  }
}

function dedupeRankedFacts(
  entries: Array<{ row: FactRow; score: number }>
): Array<{ row: FactRow; score: number }> {
  const seen = new Set<string>()
  const out: Array<{ row: FactRow; score: number }> = []
  for (const entry of entries) {
    if (seen.has(entry.row.id)) continue
    seen.add(entry.row.id)
    out.push(entry)
  }
  return out
}

/** Downrank or drop generated-site artifacts that pollute graph retrieval. */
export function retrievalFactPenalty(row: FactRow): number {
  if (isExcludedRetrievalFact(row)) return 1
  const ref = row.source_ref ?? ''
  const text = row.fact_text
  if (ref.includes('_site/') || text.includes('docs/_site/')) return 0.45
  if (/attribute_value exported from docs\/_site\//i.test(text)) return 0.45
  return 0
}

export function isExcludedRetrievalFact(row: FactRow): boolean {
  const ref = row.source_ref ?? ''
  const text = row.fact_text
  return (
    ref.includes('_site/') ||
    text.includes('docs/_site/') ||
    /attribute_value exported from docs\/_site\//i.test(text)
  )
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

export function buildPondQueries(query: string, queryTokens: string[], maxPonds: number): string[] {
  const ponds: string[] = []
  const add = (candidate: string) => {
    const normalized = candidate.trim().replace(/\s+/g, ' ')
    if (normalized.length <= 2) return
    if (!ponds.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
      ponds.push(normalized)
    }
  }

  add(query.trim())
  for (let i = 0; i < queryTokens.length; i++) {
    for (let j = i + 1; j < queryTokens.length; j++) {
      add(`${queryTokens[i]} ${queryTokens[j]}`)
    }
  }
  if (queryTokens.length >= 3) {
    add(`${queryTokens[0]} ${queryTokens[1]} ${queryTokens[2]}`)
  }
  for (const token of queryTokens) add(token)
  return isUnlimited(maxPonds) ? ponds : ponds.slice(0, maxPonds)
}

function buildExplorationPonds(query: string, queryTokens: string[], maxPonds: number): ExplorationPond[] {
  return buildPondQueries(query, queryTokens, maxPonds).map((pondQuery, id) => ({
    id,
    query: pondQuery,
    frontierFactIds: [],
    hops: 0,
    exhausted: false,
  }))
}

function seedPondFrontiers(indexer: SqliteKbIndexer, ponds: ExplorationPond[]): void {
  for (const pond of ponds) {
    const rows = indexer.searchFacts(pond.query, 8)
    pond.frontierFactIds = pickDiverseSeedFacts(rows, 5)
  }
}

/**
 * Distance of every repo from `primaryRepo`, via BFS over the cross-repo edge tree.
 * The landed repo is distance 0; repos it links to are 1, and so on. Repos with no path
 * (or when there is no primary repo) are simply absent and treated as far away.
 */
function computeRepoDistances(
  primaryRepo: string | null,
  links: Array<{ fromRepo: string; toRepo: string; weight: number }>
): Map<string, number> {
  const distances = new Map<string, number>()
  if (!primaryRepo) return distances
  const adjacency = new Map<string, string[]>()
  for (const link of links) {
    if (!adjacency.has(link.fromRepo)) adjacency.set(link.fromRepo, [])
    adjacency.get(link.fromRepo)?.push(link.toRepo)
  }
  distances.set(primaryRepo, 0)
  const queue: string[] = [primaryRepo]
  while (queue.length > 0) {
    const repo = queue.shift() as string
    const depth = distances.get(repo) ?? 0
    for (const next of adjacency.get(repo) ?? []) {
      if (distances.has(next)) continue
      distances.set(next, depth + 1)
      queue.push(next)
    }
  }
  return distances
}

/**
 * Repo distance for a fact: landed repo 0, known siblings by tree depth, otherwise far.
 * An empty `distances` map (single-repo / unreconciled base) makes every fact equidistant, so
 * scoring and ordering fall back to pure score — no repo boost, no reordering.
 */
function repoDistanceFor(gitRepo: string | null, distances: Map<string, number>): number {
  if (!gitRepo) return Number.MAX_SAFE_INTEGER
  return distances.get(gitRepo) ?? Number.MAX_SAFE_INTEGER
}

/** Score boost by repo distance: 0 → +0.18, 1 → +0.10, 2 → +0.05, further/unknown → 0. */
function repoBoostForDistance(distance: number): number {
  if (distance === 0) return 0.18
  if (distance === 1) return 0.1
  if (distance === 2) return 0.05
  return 0
}

function pickDiverseSeedFacts(rows: FactRow[], limit: number): string[] {
  const picked: string[] = []
  const seenKinds = new Set<string>()
  for (const row of rows) {
    if (picked.length >= limit) break
    if (seenKinds.has(row.source_kind) && picked.length >= 2) continue
    seenKinds.add(row.source_kind)
    picked.push(row.id)
  }
  for (const row of rows) {
    if (picked.length >= limit) break
    if (!picked.includes(row.id)) picked.push(row.id)
  }
  return picked
}

function selectNextPond(
  ponds: ExplorationPond[],
  start: number
): { pond: ExplorationPond; index: number } | null {
  if (ponds.length === 0) return null
  for (let offset = 0; offset < ponds.length; offset++) {
    const index = (start + offset) % ponds.length
    const pond = ponds[index]
    if (!pond.exhausted) return { pond, index }
  }
  return null
}

function markPondExhaustedIfStalled(
  pond: ExplorationPond,
  edgeNeighborRows: FactRow[],
  pondLexicalRows: FactRow[],
  seenFactIds: Set<string>
): void {
  const pondLexicalStalled =
    pondLexicalRows.length === 0 || pondLexicalRows.every(row => seenFactIds.has(row.id))
  if (edgeNeighborRows.length === 0 && pondLexicalStalled) {
    pond.exhausted = true
  }
}

function pickPondFrontier(input: {
  edgeNeighborRows: FactRow[]
  pondLexicalRows: FactRow[]
  topRows: FactRow[]
  limit: number
}): string[] {
  const ids = new Set<string>()
  for (const row of input.edgeNeighborRows) ids.add(row.id)
  for (const row of input.pondLexicalRows.slice(0, 6)) ids.add(row.id)
  for (const row of input.topRows.slice(0, input.limit)) ids.add(row.id)
  return [...ids].slice(0, input.limit)
}

function maybeSpawnConceptPond(
  ponds: ExplorationPond[],
  newConcepts: string[],
  maxPonds: number,
  indexer: SqliteKbIndexer
): void {
  if (ponds.length >= ABSOLUTE_MAX_PONDS) return
  if (!isUnlimited(maxPonds) && ponds.length >= maxPonds) return
  if (newConcepts.length < 2) return
  const query = newConcepts.slice(0, 3).join(' ')
  if (ponds.some(pond => pond.query.toLowerCase() === query.toLowerCase())) return
  const rows = indexer.searchFacts(query, 8)
  if (rows.length === 0) return
  ponds.push({
    id: ponds.length,
    query,
    frontierFactIds: pickDiverseSeedFacts(rows, 5),
    hops: 0,
    exhausted: false,
  })
}

function summarizePondQuery(query: string): string {
  const compact = query.trim().replace(/\s+/g, '+')
  return compact.length <= 28 ? compact : `${compact.slice(0, 25)}...`
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
  // Require at least one new high-quality (score >= 0.5) fact — prevents iterating on junk
  if (current.relevantFacts >= previous.relevantFacts + 1) return true
  if (current.conceptCoverage >= previous.conceptCoverage + 0.08) return true
  if (current.avgTop >= previous.avgTop + 0.04) return true
  if (current.frontierConcepts > previous.frontierConcepts) return true
  if (current.activePonds < previous.activePonds) return true
  return false
}


function clampLimitInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed === -1) return -1
  return Math.max(min, Math.min(max, parsed))
}

export function isUnlimitedLimit(limit: number): boolean {
  return limit === -1
}

function isUnlimited(limit: number): boolean {
  return isUnlimitedLimit(limit)
}

function withinLimit(current: number, limit: number): boolean {
  return isUnlimited(limit) || current < limit
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function buildFactsLoopFingerprint(query: string): string {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex')
}
