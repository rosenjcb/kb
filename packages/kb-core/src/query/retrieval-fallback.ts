import { formatFactUri } from '@kb/core/core/fact-uri.js'

export interface ReadDocumentsLikeResult {
  results?: Array<{
    metadata?: {
      id?: string
      title?: string
      filePath?: string
    }
    content?: string
  }>
  retrieval?: {
    method?: string
    detail?: string
    checkpoints?: Array<{
      stage?: string
      status?: string
      nextAction?: string
      confidence?: number
    }>
  }
}

/** Human footer cap for `sources>` — highest-ranked fact ids only. */
export const TOP_SOURCE_PREVIEW_LIMIT = 10

export function formatReadDocumentSourceIds(results: ReadDocumentsLikeResult['results']): string[] {
  if (!Array.isArray(results) || results.length === 0) return []

  const ids = results
    .map(result => result.metadata?.id)
    .filter((value): value is string => Boolean(value))

  return [...new Set(ids)].slice(0, TOP_SOURCE_PREVIEW_LIMIT)
}

/** Terminal `sources>` value — explicitly marks top-N of ranked pool. */
export function formatReadDocumentSourcesPreview(results: ReadDocumentsLikeResult['results']): string {
  const total = Array.isArray(results) ? results.length : 0
  if (total === 0) return '(none)'

  const sourceIds = formatReadDocumentSourceIds(results)
  if (sourceIds.length === 0) return '(none)'

  const refs = sourceIds.map(formatFactUri).join('; ')
  if (total <= TOP_SOURCE_PREVIEW_LIMIT) {
    return `all ${total} ranked: ${refs}`
  }
  return `top ${sourceIds.length} of ${total} ranked: ${refs}`
}
