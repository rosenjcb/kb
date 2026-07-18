/**
 * Serialize an `IntentResult` into stable JSON shapes for network clients
 * (Slack / REST) and MCP. Keeps the wire contract decoupled from the internal
 * retrieval representation.
 */

import type { ReadDocumentsResultData, ReadDocumentsResultItem } from '@kb/core/query/intent-cli.js'
import type { IntentResult } from '@kb/core/intents/types.js'

export interface QuerySource {
  id?: string
  title?: string
  /**
   * Openable location of the evidence: the physical source file the fact was
   * extracted from when known, otherwise the fact's `fact://` id as a last resort.
   * Multi-repo bases usually prefix with `<gitRepo>/…`.
   */
  filePath?: string
  /**
   * Origin repo slug (`facts.git_repo` / clone dir name). Lets consumers build
   * per-repo blob links without re-parsing `filePath`.
   */
  gitRepo?: string
  /** For code facts, the exported symbol the fact describes. */
  symbol?: string
  tags?: string[]
  snippet?: string
}

export interface QueryResponseBody {
  status: IntentResult['status']
  answer: string | null
  results: QuerySource[]
  retrieval: {
    method?: string
    detail?: string
  }
  confidence?: number
  /** Server-side path to the deep trace dump when `trace: true` was requested. */
  traceFile?: string
}

const SNIPPET_MAX_CHARS = 280

function buildSnippet(content: string | undefined): string | undefined {
  if (!content) return undefined
  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith('Created:') &&
        !line.startsWith('Tags:') &&
        !line.startsWith('Type:')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length <= SNIPPET_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

function gitRepoFromItem(item: ReadDocumentsResultItem): string | undefined {
  const direct = item.metadata?.gitRepo?.trim()
  if (direct) return direct
  // tags are typically `[source_kind, git_repo, 'fact']` — prefer an explicit field.
  const tags = item.metadata?.tags
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const t = tag.trim()
    if (!t || t === 'fact' || t.startsWith('import_')) continue
    // Heuristic: slug-like tag that also prefixes sourcePath.
    const location = item.metadata?.sourcePath ?? item.metadata?.filePath
    if (location?.startsWith(`${t}/`) || location === t) return t
  }
  return undefined
}

function toSource(item: ReadDocumentsResultItem): QuerySource {
  // Prefer the physical source file (what an agent can open/grep) over the
  // opaque `fact://` URI; fall back to the URI only when provenance is unknown.
  const location = item.metadata?.sourcePath ?? item.metadata?.filePath
  const gitRepo = gitRepoFromItem(item)
  return {
    id: item.metadata?.id,
    title: item.metadata?.title,
    filePath: location,
    ...(gitRepo ? { gitRepo } : {}),
    ...(item.metadata?.symbol ? { symbol: item.metadata.symbol } : {}),
    tags: item.metadata?.tags,
    snippet: buildSnippet(item.content),
  }
}

/** Map an `IntentResult` to the REST `POST /v1/query` response body. */
export function serializeQueryResult(result: IntentResult): QueryResponseBody {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []

  return {
    status: result.status,
    answer: data.answer?.trim() || null,
    results: results.map(toSource),
    retrieval: {
      method: data.retrieval?.method,
      detail: data.retrieval?.detail,
    },
    ...(typeof result.confidence === 'number' ? { confidence: result.confidence } : {}),
    ...(typeof data.traceFile === 'string' && data.traceFile ? { traceFile: data.traceFile } : {}),
  }
}
