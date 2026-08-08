import type { EvidenceLabel } from '../core/evidence-label'
import { isEnvTrue } from '../config/env-boolean.js'
import type { LLMFailure } from '../core/llm-error.js'
import type { RunCollector } from '../core/telemetry'
import type { DocType } from '../core/doc-taxonomy'
import type { LLMProvider } from '../core/types'
import { type CuratorRequery, type CurationRecord, curateFacts, shouldCurate } from './fact-curator'
import { type Embedder, createEmbedder } from '../core/embeddings'
import {
  DEFAULT_FACT_LIMIT,
  type HybridRetrievalResult,
  factToUnit,
  retrieveHybrid,
} from './hybrid-retriever'
import type { InquiryLane } from '../query/inquiry-lanes.js'
import { expandQuery, shouldExpandQuery } from './query-expander'
import { SqliteKbIndexer } from './sqlite-kb-index'

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
  /**
   * Ontology-typed sub-query lanes from `query/inquiry-lanes.ts`, built by the
   * caller from the stage-0 scope verdict. When present these replace the generic
   * LLM expander for the deep fan-out — they are deterministic, entity-grounded,
   * and not gated on query length.
   */
  inquiryLanes?: InquiryLane[]
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
    const includeContent = input.includeContent === true

    if (input.allFacts || this.defaultAllFacts) {
      if (this.allFactsDumped) {
        return {
          results: [],
          total: 0,
          retrieval: { method: 'lexical', detail: 'all-facts:already-in-context' },
        }
      }
      this.allFactsDumped = true
      const results = this.indexer
        .listFactsForQuery(99999)
        .map(row => factToUnit(row, includeContent))
      return {
        results,
        total: results.length,
        retrieval: { method: 'lexical', detail: 'all-facts' },
      }
    }

    const baseQuery = input.query?.trim() ?? ''
    const excludeIdSet =
      input.excludeIds && input.excludeIds.length > 0 ? new Set(input.excludeIds) : undefined

    // H5 ablation: score against the raw question (env-provided) while discovery stays on
    // the (expanded) baseQuery. Curator keying below is switched to the same raw question.
    const rawScoringQuery = isEnvTrue(process.env.KB_ABLATE_RAW_SCORING)
      ? process.env.KB_ABLATE_RAW_Q?.trim() || undefined
      : undefined

    // Pre-embed once so every retrieval pass scores against one real query vector rather than
    // re-embedding. Best-effort; a no-op without an embedder.
    await this.indexer.cacheQueryEmbedding(rawScoringQuery ?? baseQuery)

    const runRetrieval = (query: string) =>
      retrieveHybrid(this.indexer, {
        query: rawScoringQuery ?? query,
        limit,
        includeContent,
        ...(excludeIdSet ? { excludeIds: excludeIdSet } : {}),
      })

    if (input.discoveryDepth !== 'deep') {
      const shallow = runRetrieval(baseQuery)
      return {
        results: shallow.units,
        total: shallow.units.length,
        retrieval: {
          method: shallow.units.length > 0 ? 'hybrid' : 'lexical-fallback',
          detail: shallow.detail,
        },
      }
    }

    // Deep mode fans the question out over sub-queries and fuses the results. Ontology-typed
    // lanes win whenever the caller resolved an entity: they are deterministic,
    // entity-grounded, need no LLM call, and are deliberately NOT gated on query length — a
    // long vague question benefits from targeted probes as much as a one-word one does. The
    // generic LLM expander stays as the fallback, keeping its original short-query gate.
    const typedLanes = input.inquiryLanes ?? []
    let expansions: string[] = typedLanes.map(lane => lane.query)
    if (expansions.length === 0 && this.llm && baseQuery && shouldExpandQuery(baseQuery)) {
      expansions = await expandQuery(this.llm, baseQuery)
    }

    const passes = [baseQuery, ...expansions].filter(Boolean).map(runRetrieval)
    const merged = mergeRetrievals(
      passes,
      limit,
      expansions.length,
      typedLanes.length > 0 ? describeTypedLanes(typedLanes) : undefined
    )
    return this.curateRelevance(merged, baseQuery, includeContent, excludeIdSet, input.collector)
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

    // Bounded, cheap re-discovery: a single shallow hybrid pass over the gap sub-query,
    // skipping anything already known (incoming pool + the caller's session exclusions).
    const requery: CuratorRequery = async (gap, knownIds, budget) => {
      const { units } = retrieveHybrid(this.indexer, {
        query: gap,
        limit: budget * 3,
        includeContent,
        ...(excludeIds ? { excludeIds } : {}),
      })
      const out: QueryResult[] = []
      for (const unit of units) {
        if (knownIds.has(unit.metadata.id)) continue
        out.push(unit)
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

}

/** `facets:ownership+mechanism` — which typed probes ran, for --debug / --trace. */
function describeTypedLanes(lanes: InquiryLane[]): string {
  return `facets:${[...new Set(lanes.map(lane => lane.facet))].join('+')}`
}

/**
 * Fuse the fan-out passes with Reciprocal Rank Fusion, so a unit that several sub-queries
 * agree on outranks one that only the first pass happened to surface. Interleaving by pass
 * order (the old merge) made lane 1's tail beat lane 2's head.
 */
function mergeRetrievals(
  passes: HybridRetrievalResult[],
  limit: number,
  expansionCount: number,
  lanesDetail?: string
): QueryResponse {
  const RRF_K = 60
  const scores = new Map<string, number>()
  const byId = new Map<string, QueryResult>()
  for (const pass of passes) {
    pass.units.forEach((unit, index) => {
      const id = unit.metadata.id
      if (!byId.has(id)) byId.set(id, unit)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  const merged = [...byId.values()]
    .sort((a, b) => (scores.get(b.metadata.id) ?? 0) - (scores.get(a.metadata.id) ?? 0))
    .slice(0, limit)

  const baseDetail = passes[0]?.detail ?? 'hybrid'
  return {
    results: merged,
    total: merged.length,
    retrieval: {
      method: merged.length > 0 ? 'hybrid' : 'lexical-fallback',
      detail: `${baseDetail};expanded:${expansionCount}${lanesDetail ? `;${lanesDetail}` : ''}`,
    },
  }
}
