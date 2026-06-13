import type { DocType } from '../core/doc-taxonomy'
import { formatFactUri } from '../core/fact-uri'
import type { LLMProvider } from '../core/types'
import { DEFAULT_FACT_LIMIT, FactsQueryResearchOrchestrator, MAX_FACTS_FOR_LLM } from './facts-query-research-orchestrator'
import { filterRelevantFacts, shouldRunRelevanceFilter } from './facts-relevance-filter'
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
      const categoryNames = this.indexer.getFactCategoryNamesForFacts(rows.map(row => row.id))
      const results = rows.map(row =>
        this.toResult(row, input.includeContent === true, categoryNames.get(row.id) ?? [])
      )
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
        limit,
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
          const merged = mergeQueryResponses(responses, MAX_FACTS_FOR_LLM, expansions.length)
          return this.maybeFilterRelevance(merged, baseQuery)
        }
      }

      const response = await orchestrator.run({ query: baseQuery, ...opts, excludeIds: excludeIdSet })
      return this.maybeFilterRelevance(response, baseQuery)
    }
    const rows = this.readRows(input, limit)
    const categoryNames = this.indexer.getFactCategoryNamesForFacts(rows.map(row => row.id))
    const results = rows.map(row =>
      this.toResult(row, input.includeContent === true, categoryNames.get(row.id) ?? [])
    )
    return {
      results,
      total: results.length,
      retrieval: { method: 'lexical', detail: 'facts+graph-first' },
    }
  }

  private async maybeFilterRelevance(response: QueryResponse, query: string): Promise<QueryResponse> {
    if (!this.llm || !shouldRunRelevanceFilter(response.results)) return response
    // Judge already confirmed sufficiency — skip redundant relevance filter call
    if (response.retrieval.detail?.includes('llm_judge_answerable')) return response
    const filtered = await filterRelevantFacts(this.llm, query, response.results)
    if (filtered === response.results) return response
    return {
      ...response,
      results: filtered,
      total: filtered.length,
      retrieval: {
        ...response.retrieval,
        detail: `${response.retrieval.detail ?? ''};relevance_filtered:${filtered.length}`,
      },
    }
  }

  private readRows(input: QueryDocumentsInput, limit: number): FactRow[] {
    const query = input.query?.trim()
    if (!query) return this.indexer.listFactsForQuery(limit)
    return this.indexer.searchFacts(query, limit)
  }

  private toResult(row: FactRow, includeContent: boolean, categories: string[]): QueryResult {
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
        tags: [row.source_kind, ...categories, 'fact'],
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
  limit: number,
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
    results: merged.slice(0, limit),
    total: Math.min(merged.length, limit),
    retrieval: {
      method: merged.length > 0 ? 'hybrid' : 'lexical-fallback',
      detail: `${baseDetail};expanded:${expansionCount}`,
    },
  }
}
