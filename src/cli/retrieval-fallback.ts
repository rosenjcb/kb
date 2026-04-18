import { readFile } from 'node:fs/promises'
import path from 'node:path'

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

export async function augmentReadDocumentsWithWorkspaceFallback(
  question: string,
  retrieval: ReadDocumentsLikeResult,
  workspaceDir: string
): Promise<ReadDocumentsLikeResult> {
  if (!shouldUseWorkspaceFallback(question, retrieval)) {
    return retrieval
  }

  const fallbackResults = await loadWorkspaceFallbackResults(workspaceDir)
  if (fallbackResults.length === 0) {
    return retrieval
  }

  return {
    ...retrieval,
    results: [...(retrieval.results ?? []), ...fallbackResults].slice(0, 8),
    retrieval: {
      method: retrieval.retrieval?.method ?? 'lexical',
      detail: appendRetrievalDetail(retrieval.retrieval?.detail, 'workspace-fallback'),
      checkpoints: retrieval.retrieval?.checkpoints,
    },
  }
}

export function appendRetrievalDetail(base: string | undefined, suffix: string): string {
  if (!base) return suffix
  return `${base};${suffix}`
}

export function formatReadDocumentSourceIds(results: ReadDocumentsLikeResult['results']): string[] {
  if (!Array.isArray(results) || results.length === 0) return []

  const ids = results
    .map(result => result.metadata?.id)
    .filter((value): value is string => Boolean(value))

  return [...new Set(ids)].slice(0, 10)
}

function shouldUseWorkspaceFallback(question: string, retrieval: ReadDocumentsLikeResult): boolean {
  if (!isBroadProjectQuestion(question)) {
    return false
  }

  const results = retrieval.results
  if (!results || results.length === 0) {
    return true
  }

  const confidence = getFinalCheckpointConfidence(retrieval)
  if (typeof confidence === 'number' && confidence < 0.72) {
    return true
  }

  const ids = formatReadDocumentSourceIds(results)
  if (ids.length === 0) {
    return true
  }

  return ids.every(isLowSignalSourceId)
}

function isLowSignalSourceId(id: string): boolean {
  return id.startsWith('ticket-') || id.startsWith('session-log-') || id === 'general-facts'
}

function isBroadProjectQuestion(question: string): boolean {
  const text = question.toLowerCase()
  return /(what is this project|what is this repo|project about|purpose|goal|mission|scope)/.test(
    text
  )
}

async function loadWorkspaceFallbackResults(
  workspaceDir: string
): Promise<NonNullable<ReadDocumentsLikeResult['results']>> {
  const docs = [
    { id: 'workspace-readme', fileName: 'README.md' },
    { id: 'workspace-gameplan', fileName: 'GAMEPLAN.md' },
  ]

  const results: NonNullable<ReadDocumentsLikeResult['results']> = []

  for (const doc of docs) {
    try {
      const filePath = path.join(workspaceDir, doc.fileName)
      const content = await readFile(filePath, 'utf8')
      const clipped = content.length > 1800 ? `${content.slice(0, 1800)}...` : content
      results.push({
        metadata: { id: doc.id, filePath },
        content: clipped,
      })
    } catch {
      // Best-effort fallback: skip missing files.
    }
  }

  return results
}

function getFinalCheckpointConfidence(retrieval: ReadDocumentsLikeResult): number | undefined {
  const checkpoints = retrieval.retrieval?.checkpoints
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return undefined
  return checkpoints[checkpoints.length - 1]?.confidence
}
