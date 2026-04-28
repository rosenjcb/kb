import { SqliteKbIndexer, type FactRow } from './sqlite-kb-index'
import { FactsQueryResearchOrchestrator } from './facts-query-research-orchestrator'

export interface QueryDocumentsInput {
  query?: string
  mode?: 'id' | 'title' | 'tags' | 'content'
  discoveryDepth?: 'shallow' | 'deep'
  tags?: string[]
  type?: 'architecture' | 'decision' | 'checklist' | 'runbook' | 'reference'
  limit?: number
  includeContent?: boolean
  surface?: 'query' | 'chat'
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
    clarificationQuestion?: string
  }
}

export class FactsDocumentReader {
  private readonly indexer: SqliteKbIndexer

  constructor(dbPath: string) {
    this.indexer = new SqliteKbIndexer({ dbPath })
  }

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    const limit = input.limit ?? 10
    if (input.discoveryDepth === 'deep') {
      const orchestrator = new FactsQueryResearchOrchestrator(this.indexer)
      return orchestrator.run({
        query: input.query?.trim() ?? '',
        limit,
        includeContent: input.includeContent === true,
        surface: input.surface ?? 'query',
      })
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
        filePath: `fact://${row.id}`,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: [row.source_kind, 'fact'],
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
