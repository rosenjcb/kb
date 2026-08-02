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
  /** ISO mtime of `.kb-index.sqlite` (last index DB write: init/scan/reindex). */
  indexMtime?: string | null
  indexing?: boolean
  bootstrapError?: string | null
  bootstrapProgress?: string | null
  reindexing?: boolean
  /** Package versions served by this node (user-facing binaries only). */
  version?: {
    server: string
  }
}

export interface QueryRequest {
  q?: string
  query?: string
  discovery?: 'shallow' | 'deep'
  synthesize?: boolean
  verbose?: boolean
  trace?: boolean
  /** Optional per-call base override (else the connection's `X-KB-Base`). */
  base?: string
}

export interface QuerySource {
  id?: string
  title?: string
  filePath?: string
  /** Origin repo slug (`facts.git_repo`) when known — used for per-repo source links. */
  gitRepo?: string
  symbol?: string
  tags?: string[]
  snippet?: string
}

/** Why an LLM-backed stage failed, as reported by the server. */
export interface LLMFailureResponse {
  stage: string
  kind: string
  message: string
  provider?: string
  status?: number
  retryable: boolean
}

export interface QueryResponse {
  status: string
  answer?: string | null
  results: QuerySource[]
  retrieval?: { method?: string; detail?: string; degraded?: LLMFailureResponse[] }
  confidence?: number
  /** Set when synthesis was attempted and failed; `answer` is null and this says why. */
  answerError?: LLMFailureResponse
  traceFile?: string
}

export interface ChatRequest {
  sessionId?: string
  message: string
  /** Optional per-call base override (else the connection's `X-KB-Base`). */
  base?: string
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
