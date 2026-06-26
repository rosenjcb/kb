import type { DocType } from '../core/doc-taxonomy'
import { formatFactUri } from '../core/fact-uri'
import type { LLMProvider } from '../core/types'
import {
  type CuratorRequery,
  type CurationRecord,
  curateFacts,
  shouldCurate,
} from './fact-curator'
import { DEFAULT_FACT_LIMIT, FactsQueryResearchOrchestrator } from './facts-query-research-orchestrator'
import { makeSufficiencyJudge } from './facts-sufficiency-judge'
import { expandQuery, shouldExpandQuery } from './query-expander'
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
  /** Fact IDs already in the caller's session pool — orchestrator will skip these entirely. */
  excludeIds?: string[]
  /** When true, bypass all query expansion and load every fact in the KB. */
  allFacts?: boolean
}

export interface QueryResult {
  metadata: {
    id: string
    title: string
    filePath: string
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
      confidence?: number
    }>
    /** Out-of-band curator audit — kept/dropped/re-queried decisions. Never injected into context. */
    curation?: CurationRecord
  }
}

export class FactsDocumentReader {
  private readonly indexer: SqliteKbIndexer
  private allFactsDumped = false

  constructor(
    dbPath: string,
    private readonly llm?: LLMProvider,
    private readonly defaultAllFacts?: boolean
  ) {
    this.indexer = new SqliteKbIndexer({ dbPath })
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
      const judge = this.llm ? makeSufficiencyJudge(this.llm) : undefined
      const orchestrator = new FactsQueryResearchOrchestrator(this.indexer, { judge })
      const baseQuery = input.query?.trim() ?? ''
      const opts = {
        includeContent: input.includeContent === true,
        surface: input.surface ?? 'query',
      } as const

      const excludeIdSet =
        input.excludeIds && input.excludeIds.length > 0
          ? new Set(input.excludeIds)
          : undefined

      if (this.llm && baseQuery && shouldExpandQuery(baseQuery)) {
        const expansions = await expandQuery(this.llm, baseQuery)
        if (expansions.length > 0) {
          const responses = await Promise.all(
            [baseQuery, ...expansions].map(q =>
              orchestrator.run({ query: q, ...opts, excludeIds: excludeIdSet })
            )
          )
          const merged = mergeQueryResponses(responses, expansions.length)
          return this.curateRelevance(merged, baseQuery, opts.includeContent, excludeIdSet)
        }
      }

      const response = await orchestrator.run({ query: baseQuery, ...opts, excludeIds: excludeIdSet })
      return this.curateRelevance(response, baseQuery, opts.includeContent, excludeIdSet)
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
    excludeIds?: Set<string>
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

    const { results, record } = await curateFacts({
      llm: this.llm,
      query,
      results: response.results,
      requery,
    })

    if (record.fellBack && record.dropped.length === 0 && record.added === 0) return response

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
    return {
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: formatFactUri(row.id),
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

function mergeQueryResponses(
  responses: QueryResponse[],
  expansionCount: number
): QueryResponse {
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
