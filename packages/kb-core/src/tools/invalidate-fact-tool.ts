import path from 'node:path'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import type { FactTriplet } from './sqlite-kb-index'
import { SqliteKbIndexer } from './sqlite-kb-index'

export interface InvalidateFactInput {
  oldFact: string
  replacementFact?: string
  replacementTriplet?: FactTriplet
  preview?: boolean
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
  const { oldFact, replacementFact, replacementTriplet, preview = true } = input

  const replaceFrom = oldFact.trim()
  const replaceTo = replacementFact?.trim() ?? ''

  if (!replaceFrom) {
    return {
      changes: [],
      summary: 'No facts changed.',
      error: 'oldFact is required.',
    }
  }

  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  try {
    const changes: InvalidateFactResult['changes'] = []
    const exact = indexer.getActiveFactByTextMatch(replaceFrom)
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
      before: exact.text,
      after: replaceTo || undefined,
      replacementId: simulatedReplacementId,
    })

    if (!preview) {
      const replacementPayload =
        replaceTo.length > 0
          ? {
              factText: replaceTo,
              triplet:
                replacementTriplet?.subject &&
                replacementTriplet.predicate &&
                replacementTriplet.object
                  ? replacementTriplet
                  : placeholderTripletFromFactText(replaceTo),
            }
          : undefined
      const result = indexer.invalidateFact(exact.text, replacementPayload)
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
