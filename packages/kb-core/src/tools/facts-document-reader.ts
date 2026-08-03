import type { EvidenceLabel } from '../core/evidence-label'
import { isEnvTrue } from '../config/env-boolean.js'
import type { LLMFailure } from '../core/llm-error.js'
import type { RunCollector } from '../core/telemetry'
import { defaultTracesDir } from '../core/telemetry'
import type { DocType } from '../core/doc-taxonomy'
import { formatFactUri, sourceRefToPath } from '../core/fact-uri'
import type { LLMProvider } from '../core/types'
import { type CuratorRequery, type CurationRecord, curateFacts, shouldCurate } from './fact-curator'
import { type Embedder, createEmbedder } from '../core/embeddings'
import {
  DEFAULT_FACT_LIMIT,
  FactsQueryResearchOrchestrator,
} from './facts-query-research-orchestrator'
import { makeSufficiencyJudge } from './facts-sufficiency-judge'
import { expandQuery, shouldExpandQuery } from './query-expander'
import {
  type QueryTraceDump,
  type QueryTraceLane,
  buildCurationTrace,
  isQueryTraceEnabled,
  newTraceId,
  writeQueryTrace,
} from './query-trace'
import { type FactRow, SqliteKbIndexer } from './sqlite-kb-index'

export interface QueryDocumentsInput {
  query?: string
  mode?: 'id' | 'title' | 'tags' | 'content'
  discoveryDepth?: 'shallow' | 'deep'
  tags?: string[]
  type?: DocType
  limit?: number
  includeContent?: boolean
  surface?: 'query' | 'chat'
  /** Optional fact IDs to skip during retrieval entirely (caller-supplied exclusions). */
  excludeIds?: string[]
  /** When true, bypass all query expansion and load every fact in the KB. */
  allFacts?: boolean
  /** Telemetry collector — when set, curator/sufficiency-judge LLM calls are recorded on it. */
  collector?: RunCollector
}

export interface QueryResult {
  metadata: {
    id: string
    title: string
    filePath: string
    /** Physical source file the fact was extracted from (`source_ref` resolved), when known. */
    sourcePath?: string
    /** For code facts, the exported symbol the fact describes. */
    symbol?: string
    createdAt: string
    updatedAt: string
    tags?: string[]
    type?: QueryDocumentsInput['type']
  }
  content?: string
}

export interface QueryResponse {
  results: QueryResult[]
  total: number
  retrieval: {
    method: 'lexical' | 'hybrid' | 'lexical-fallback'
    detail?: string
    /** Per-iteration engine trace — only shown in --debug mode. */
    traceDetail?: string
    clarificationQuestion?: string
    checkpoints?: Array<{
      stage?: string
      status?: string
      nextAction?: string
      /** Categorical evidence strength — see `core/evidence-label`. */
      evidence?: EvidenceLabel
    }>
    /** Out-of-band curator audit — kept/dropped/re-queried decisions. Never injected into context. */
    curation?: CurationRecord
    /**
     * Best-effort LLM stages that failed and were skipped (sufficiency judge, curation).
     * Retrieval still succeeded; these exist so an outage is visible rather than being
     * mistaken for a retrieval-quality problem.
     */
    degraded?: LLMFailure[]
  }
  /**
   * Opt-in deep trace lane (`kb query --trace`). Present only when tracing is on; the reader
   * writes it to disk and strips it before returning, so it never reaches synthesis.
   */
  trace?: QueryTraceLane
  /** Path to the written trace dump when tracing is enabled. */
  traceFile?: string
}

export class FactsDocumentReader {
  private readonly indexer: SqliteKbIndexer
  private allFactsDumped = false

  constructor(
    dbPath: string,
    private readonly llm?: LLMProvider,
    private readonly defaultAllFacts?: boolean,
    embedder?: Embedder
  ) {
    // Default to the configured embedder (local on-device weights unless KB_EMBEDDER=gemini).
    // It is lazy: attaching it costs nothing until a real embed is requested, and every use is
    // best-effort — any failure falls back to the deterministic hash vector.
    this.indexer = new SqliteKbIndexer({ dbPath, embedder: embedder ?? createEmbedder() })
  }

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    const limit = input.limit ?? DEFAULT_FACT_LIMIT

    if (input.allFacts || this.defaultAllFacts) {
      if (this.allFactsDumped) {
        return {
          results: [],
          total: 0,
          retrieval: { method: 'lexical', detail: 'all-facts:already-in-context' },
        }
      }
      this.allFactsDumped = true
      const rows = this.indexer.listFactsForQuery(99999)
      const results = rows.map(row => this.toResult(row, input.includeContent === true))
      return {
        results,
        total: results.length,
        retrieval: { method: 'lexical', detail: 'all-facts' },
      }
    }

    if (input.discoveryDepth === 'deep') {
      // Collects best-effort stage failures across this call so they can ride out on the
      // response instead of vanishing into a bare catch.
      const degraded: LLMFailure[] = []
      const judge = this.llm
        ? makeSufficiencyJudge(this.llm, input.collector, failure => degraded.push(failure))
        : undefined
      const orchestrator = new FactsQueryResearchOrchestrator(this.indexer, { judge })
      const baseQuery = input.query?.trim() ?? ''
      // H5 ablation: score against the raw question (env-provided) while discovery stays on
      // the (expanded) baseQuery. Curator keying below is switched to the same raw question.
      const rawScoringQuery = isEnvTrue(process.env.KB_ABLATE_RAW_SCORING)
        ? process.env.KB_ABLATE_RAW_Q?.trim() || undefined
        : undefined
      const opts = {
        includeContent: input.includeContent === true,
        surface: input.surface ?? 'query',
        ...(rawScoringQuery ? { scoringQuery: rawScoringQuery } : {}),
      } as const

      // Pre-embed the string the orchestrator scores against so per-iteration semantic scoring
      // uses one real query vector (no re-embed per pass). Best-effort; no-op without an embedder.
      await this.indexer.cacheQueryEmbedding(rawScoringQuery ?? baseQuery)

      const excludeIdSet =
        input.excludeIds && input.excludeIds.length > 0 ? new Set(input.excludeIds) : undefined

      if (this.llm && baseQuery && shouldExpandQuery(baseQuery)) {
        const expansions = await expandQuery(this.llm, baseQuery)
        if (expansions.length > 0) {
          const responses = await Promise.all(
            [baseQuery, ...expansions].map(q =>
              orchestrator.run({ query: q, ...opts, excludeIds: excludeIdSet })
            )
          )
          const lanes = responses
            .map(res => res.trace)
            .filter((lane): lane is QueryTraceLane => Boolean(lane))
          const merged = mergeQueryResponses(responses, expansions.length)
          const curated = await this.curateRelevance(
            merged,
            baseQuery,
            opts.includeContent,
            excludeIdSet,
            input.collector
          )
          return this.finalizeDeep(baseQuery, lanes, curated, degraded)
        }
      }

      const response = await orchestrator.run({
        query: baseQuery,
        ...opts,
        excludeIds: excludeIdSet,
      })
      const lanes = response.trace ? [response.trace] : []
      const curated = await this.curateRelevance(
        response,
        baseQuery,
        opts.includeContent,
        excludeIdSet,
        input.collector
      )
      return this.finalizeDeep(baseQuery, lanes, curated)
    }
    const rows = this.readRows(input, limit)
    const results = rows.map(row => this.toResult(row, input.includeContent === true))
    return {
      results,
      total: results.length,
      retrieval: { method: 'lexical', detail: 'facts+graph-first' },
    }
  }

  /**
   * Post-retrieval curation: the curator hard-drops off-topic facts from the orchestrator's
   * island pool and, when it finds gaps, issues bounded shallow re-discovery queries to refill.
   * Decisions land on `retrieval.curation` (out-of-band) — never in the synthesis context.
   */
  private async curateRelevance(
    response: QueryResponse,
    query: string,
    includeContent: boolean,
    excludeIds?: Set<string>,
    collector?: RunCollector
  ): Promise<QueryResponse> {
    if (!this.llm || !shouldCurate(response.results)) return response

    // Bounded, cheap re-discovery: a single shallow FTS pass over the gap sub-query, skipping
    // anything already known (incoming pool + the caller's session exclusions).
    const requery: CuratorRequery = async (gap, knownIds, budget) => {
      const rows = this.indexer.searchFacts(gap, budget * 3)
      const out: QueryResult[] = []
      for (const row of rows) {
        if (knownIds.has(row.id) || excludeIds?.has(row.id)) continue
        out.push(this.toResult(row, includeContent))
        if (out.length >= budget) break
      }
      return out
    }

    // Bonus ablation: the curator is documented to key on the *raw* question, but `query` here
    // is the graph-expanded string. This gate feeds it the real raw question instead.
    const curatorQuery = process.env.KB_ABLATE_CURATOR_RAW_Q?.trim()
      ? process.env.KB_ABLATE_CURATOR_RAW_Q.trim()
      : query
    const { results, record } = await curateFacts({
      llm: this.llm,
      query: curatorQuery,
      results: response.results,
      requery,
      collector,
    })

    // Total fallback: nothing was curated, so no audit detail is worth reporting — but if an
    // LLM error caused it, the record still has to travel or the degradation disappears.
    if (record.fellBack && record.dropped.length === 0 && record.added === 0) {
      return record.failure
        ? { ...response, retrieval: { ...response.retrieval, curation: record } }
        : response
    }

    const detail = [
      response.retrieval.detail ?? '',
      `curated:kept=${results.length},dropped=${record.dropped.length},requeried=${record.requeried.length},rounds=${record.rounds}`,
    ]
      .filter(Boolean)
      .join(';')

    return {
      ...response,
      results,
      total: results.length,
      retrieval: { ...response.retrieval, detail, curation: record },
    }
  }

  /**
   * When tracing is on, fold discovery + curation into one dump, write it to `~/.kb/traces/`,
   * and point the user at the file. Always strips the heavy `trace` lane from the returned
   * response so the full content dump never escapes the reader into synthesis or session logs.
   */
  private async finalizeDeep(
    query: string,
    lanes: QueryTraceLane[],
    input: QueryResponse,
    degraded: LLMFailure[] = []
  ): Promise<QueryResponse> {
    // The curator swallows its own LLM errors to stay fail-safe; fold that failure in here
    // so every best-effort degradation leaves on one channel.
    const curatorFailure = input.retrieval.curation?.failure
    const allDegraded = curatorFailure ? [...degraded, curatorFailure] : degraded
    const curated: QueryResponse =
      allDegraded.length > 0
        ? { ...input, retrieval: { ...input.retrieval, degraded: allDegraded } }
        : input
    if (lanes.length > 0 && isQueryTraceEnabled()) {
      const record = curated.retrieval.curation
      const dump: QueryTraceDump = {
        traceId: newTraceId(),
        createdAt: new Date().toISOString(),
        query,
        lanes,
        ...(record ? { curation: buildCurationTrace(record, lanes, curated.results.length) } : {}),
      }
      let traceFile: string | undefined
      try {
        traceFile = await writeQueryTrace(defaultTracesDir(), dump)
        process.stderr.write(`[kb] query trace written: ${traceFile}\n`)
      } catch (err) {
        process.stderr.write(
          `[kb] Warning: could not write query trace: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
      const { trace: _trace, ...rest } = curated
      return traceFile ? { ...rest, traceFile } : rest
    }
    const { trace: _trace, ...rest } = curated
    return rest
  }

  private readRows(input: QueryDocumentsInput, limit: number): FactRow[] {
    const query = input.query?.trim()
    if (!query) return this.indexer.listFactsForQuery(limit)
    return this.indexer.searchFacts(query, limit)
  }

  private toResult(row: FactRow, includeContent: boolean): QueryResult {
    const content = includeContent
      ? row.source_kind === 'import_code' && row.source_text
        ? row.source_text
        : row.fact_text
      : undefined
    const source = sourceRefToPath(row.source_ref, row.git_repo)
    return {
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: formatFactUri(row.id),
        ...(source ? { sourcePath: source.path } : {}),
        ...(row.git_repo ? { gitRepo: row.git_repo } : {}),
        ...(source?.symbol ? { symbol: source.symbol } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, ...(row.git_repo ? [row.git_repo] : []), 'fact'],
        type: 'reference',
      },
      content,
    }
  }
}

function summarizeFactTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 72) return trimmed
  return `${trimmed.slice(0, 69)}...`
}

function mergeQueryResponses(responses: QueryResponse[], expansionCount: number): QueryResponse {
  const seen = new Set<string>()
  const merged: QueryResult[] = []
  for (const res of responses) {
    for (const result of res.results) {
      if (seen.has(result.metadata.id)) continue
      seen.add(result.metadata.id)
      merged.push(result)
    }
  }
  const first = responses[0]
  const baseDetail = first?.retrieval.detail ?? 'facts-loop'
  return {
    results: merged,
    total: merged.length,
    retrieval: {
      method: merged.length > 0 ? 'hybrid' : 'lexical-fallback',
      detail: `${baseDetail};expanded:${expansionCount}`,
    },
  }
}
