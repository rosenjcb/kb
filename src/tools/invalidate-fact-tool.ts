import path from 'node:path'
import { SqliteKbIndexer } from './sqlite-kb-index'

export interface InvalidateFactInput {
  oldFact: string
  replacementFact?: string
  preview?: boolean
  dryRun?: boolean
  includeSessionLogs?: boolean
}

export interface InvalidateFactResult {
  changes: Array<{
    factId: string
    before: string
    after?: string
    replacementId?: string
  }>
  summary: string
  error?: string
}

/**
 * InvalidateFactTool: remove or replace canonical facts in SQLite facts store.
 */
export async function invalidateFactTool(
  input: InvalidateFactInput,
  baseDir: string
): Promise<InvalidateFactResult> {
  const { oldFact, replacementFact, preview = true, dryRun = false } = input

  const replaceFrom = oldFact.trim()
  const replaceTo = replacementFact?.trim() ?? ''

  if (!replaceFrom) {
    return {
      changes: [],
      summary: 'No KB documents changed.',
      error: 'oldFact is required.',
    }
  }

  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  try {
    const changes: InvalidateFactResult['changes'] = []
    const candidates = indexer.searchFacts(replaceFrom, 10)
    const exact = candidates.find(row => row.normalized_text === replaceFrom.toLowerCase().trim())
    if (!exact) {
      return {
        changes: [],
        summary: 'Scanned facts store. 0 matches.',
        error: 'No matches found in canonical facts.',
      }
    }
    const simulatedReplacementId = replaceTo ? `fact-replacement-${Date.now()}` : undefined
    changes.push({
      factId: exact.id,
      before: exact.fact_text,
      after: replaceTo || undefined,
      replacementId: simulatedReplacementId,
    })

    if (!preview && !dryRun) {
      const result = indexer.invalidateFact(replaceFrom, replaceTo || undefined)
      changes[0].replacementId = result.replacementId
    }
    const replaced = changes.length

    return {
      changes,
      summary: `Scanned facts store. ${replaced} replacement${replaced === 1 ? '' : 's'} applied.`,
      error: replaced === 0 ? 'No matches found in canonical facts.' : undefined,
    }
  } finally {
    indexer.close()
  }
}
