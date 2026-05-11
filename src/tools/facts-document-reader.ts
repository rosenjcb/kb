import type { DocType } from '../core/doc-taxonomy'
import { formatFactUri } from '../core/fact-uri'
import type { LLMProvider } from '../core/types'
import { FactsQueryResearchOrchestrator } from './facts-query-research-orchestrator'
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
    /** Chat-only: first-pass facts loop wants another retrieval with synthetic clarification (no stdin). */
    suggestRetrievalDeepen?: boolean
  }
}

export class FactsDocumentReader {
  private readonly indexer: SqliteKbIndexer

  constructor(
    dbPath: string,
    private readonly llm?: LLMProvider
  ) {
    this.indexer = new SqliteKbIndexer({ dbPath })
  }

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    const limit = input.limit ?? 10
    if (input.discoveryDepth === 'deep') {
      const orchestrator = new FactsQueryResearchOrchestrator(this.indexer)
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
          const responses = [baseQuery, ...expansions].map(q =>
            orchestrator.run({ query: q, ...opts, excludeIds: excludeIdSet })
          )
          return mergeQueryResponses(responses, limit, expansions.length)
        }
      }

      return orchestrator.run({ query: baseQuery, ...opts, excludeIds: excludeIdSet })
    }
    const rows = this.readRows(input, limit)
    const results = rows.map(row => this.toResult(row, input.includeContent === true))
    return {
      results,
      total: results.length,
      retrieval: { method: 'lexical', detail: 'facts+graph-first' },
    }
  }

  private readRows(input: QueryDocumentsInput, limit: number): FactRow[] {
    const query = input.query?.trim()
    if (!query) return this.indexer.listFactsForQuery(limit)
    return this.indexer.searchFacts(query, limit)
  }

  private toResult(row: FactRow, includeContent: boolean): QueryResult {
    return {
      metadata: {
        id: row.id,
        title: summarizeFactTitle(row.fact_text),
        filePath: formatFactUri(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, row.lane_id, 'fact'],
        type: 'reference',
      },
      content: includeContent ? row.fact_text : undefined,
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
