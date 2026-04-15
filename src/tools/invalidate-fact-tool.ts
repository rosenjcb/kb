import path from 'node:path'
import { classifyDocumentLane, type RetrievalLane } from './retrieval-lane-router'
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
    documentId: string
    title: string
    before: string
    after: string
    diff: string
    replaced: number
  }>
  summary: string
  error?: string
}

/**
 * InvalidateFactTool: remove or replace a fact across KB documents stored in SQLite.
 * Scope is limited to the active KB store only; it does not scan or edit repo source files.
 */
export async function invalidateFactTool(
  input: InvalidateFactInput,
  baseDir: string,
): Promise<InvalidateFactResult> {
  const {
    oldFact,
    replacementFact,
    preview = true,
    dryRun = false,
    includeSessionLogs = true,
  } = input

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
    const rows = indexer.getAllDocumentsForLexical()
    const escaped = replaceFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tokenLike = /^[a-z0-9_-]+$/i.test(replaceFrom)
    const regex = new RegExp(tokenLike ? `\\b${escaped}\\b` : escaped, 'g')

    const changes: InvalidateFactResult['changes'] = []
    let totalReplaced = 0

    for (const row of rows) {
      const tags = parseTags(row.tags_json)
      const lane = (row.lane ?? classifyDocumentLane(
        row.id,
        row.title,
        row.doc_type,
        tags,
        row.file_path,
      )) as RetrievalLane

      if (!includeSessionLogs && lane === 'session-log') {
        continue
      }

      const matches = row.content.match(regex)
      if (!matches) continue

      const after = row.content.replace(regex, replaceTo)
      totalReplaced += matches.length
      changes.push({
        documentId: row.id,
        title: row.title,
        before: row.content,
        after,
        diff: diffSummary(row.content, after),
        replaced: matches.length,
      })

      if (!preview && !dryRun) {
        indexer.upsertDocumentWithContent({
          id: row.id,
          title: row.title,
          content: after,
          docType: row.doc_type,
          lane,
          tags,
          createdAt: row.created_at,
        })
      }
    }

    return {
      changes,
      summary: `Scanned ${rows.length} KB documents. ${totalReplaced} replacements in ${changes.length} documents.`,
      error: totalReplaced === 0 ? 'No matches found in KB documents.' : undefined,
    }
  } finally {
    indexer.close()
  }
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return []
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function diffSummary(before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const diffs: string[] = []
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      diffs.push(`- ${beforeLines[index] || ''}`)
      diffs.push(`+ ${afterLines[index] || ''}`)
    }
  }
  return diffs.join('\n')
}
