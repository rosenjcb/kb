/** Wire types mirroring packages/kb-server/http/openapi.yaml */

export interface ServerConnection {
  /** Base URL without trailing slash, e.g. http://localhost:38117 */
  url: string
  apiKey?: string
  /** Optional base name hint for client display */
  base?: string
}

export interface HealthResponse {
  ok: boolean
  base: string
  provider?: string | null
  model?: string | null
  indexMtime?: string | null
  indexing?: boolean
  bootstrapError?: string | null
  bootstrapProgress?: string | null
  reindexing?: boolean
}

export interface QueryRequest {
  q?: string
  query?: string
  limit?: number
  type?: string
  discovery?: 'shallow' | 'deep'
  synthesize?: boolean
  verbose?: boolean
  trace?: boolean
}

export interface QuerySource {
  id?: string
  title?: string
  filePath?: string
  tags?: string[]
  snippet?: string
}

export interface QueryResponse {
  status: string
  answer?: string | null
  results: QuerySource[]
  retrieval?: { method?: string; detail?: string }
  confidence?: number
  traceFile?: string
}

export interface ChatRequest {
  sessionId?: string
  message: string
}

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'reasoning'; text: string }
  | { type: 'meta'; text: string }
  | { type: 'answer'; text: string; sources: QuerySource[]; factsRetrieved: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface ApiErrorBody {
  error: string
  status?: string
  progress?: string
}
