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

export function formatReadDocumentSourceIds(results: ReadDocumentsLikeResult['results']): string[] {
  if (!Array.isArray(results) || results.length === 0) return []

  const ids = results
    .map(result => result.metadata?.id)
    .filter((value): value is string => Boolean(value))

  return [...new Set(ids)].slice(0, 10)
}
