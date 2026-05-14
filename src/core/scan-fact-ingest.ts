import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { placeholderTripletFromFactText } from './fact-triplet-placeholder'
import { segmentMarkdownForFacts } from './sentence-split'
import { yieldEvery } from './yield'

export interface ScanFactIngestInput {
  baseDir: string
  files: Record<string, string>
  yieldEverySegments?: number
  /** When true, look up the nearest exported AST symbol for each segment and attach a relatesTo triplet. */
  matchAstNodes?: boolean
}

export interface ScanFactIngestResult {
  filesScanned: number
  segmentsUpserted: number
}

/** Extract FTS-safe tokens from fact text for kg_nodes_fts lookup. */
function ftsQueryFromText(text: string, maxTerms = 8): string {
  return text
    .split(/\W+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, maxTerms)
    .join(' OR ')
}

interface KgNodeRow {
  id: string
  name: string
  qualified_name: string | null
  path: string | null
}

/**
 * Deterministic ingest: segment each markdown source → `facts` rows (`import_doc`, `sourceRef` path#sN).
 * When `matchAstNodes` is true (requires ast-facts to have run first), each segment's triplet is
 * anchored to the nearest exported symbol via kg_nodes_fts FTS lookup instead of a placeholder.
 * Idempotent via `normalized_text` dedupe in `SqliteKbIndexer.upsertFact`.
 */
export async function ingestSourceMarkdownFilesAsFacts(
  input: ScanFactIngestInput
): Promise<ScanFactIngestResult> {
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  let astDb: Database.Database | null = null
  let findNearest: ((text: string) => KgNodeRow | null) | null = null

  if (input.matchAstNodes && existsSync(dbPath)) {
    try {
      astDb = new Database(dbPath, { readonly: true })
      const stmt = astDb.prepare<[string, number], KgNodeRow>(`
        SELECT n.id, n.name, n.qualified_name, n.path
        FROM kg_nodes_fts f
        JOIN kg_nodes n ON n.id = f.id
        WHERE kg_nodes_fts MATCH ?
          AND n.kind = 'symbol'
          AND n.exported = 1
        ORDER BY rank
        LIMIT ?
      `)
      findNearest = (text: string) => {
        const q = ftsQueryFromText(text)
        if (!q) return null
        try {
          return stmt.get(q, 1) ?? null
        } catch {
          return null
        }
      }
    } catch {
      astDb = null
      findNearest = null
    }
  }

  let filesScanned = 0
  let segmentsUpserted = 0
  let processedSegments = 0
  const yieldStride = input.yieldEverySegments ?? 50
  try {
    const paths = Object.keys(input.files).sort()
    for (const relPath of paths) {
      const raw = input.files[relPath]
      if (!raw?.trim()) continue
      filesScanned += 1
      const sourceLabel = path.basename(relPath, path.extname(relPath))
      const segments = segmentMarkdownForFacts(raw).map(s => s.replace(/\s+/g, ' ').trim())
      let segIdx = 0
      for (const factText of segments) {
        const sourceRef = `${relPath}#s${segIdx}`
        segIdx += 1

        let triplet = placeholderTripletFromFactText(factText)
        if (findNearest) {
          const node = findNearest(factText)
          if (node) {
            triplet = {
              subject: sourceLabel,
              predicate: 'relatesTo',
              object: node.qualified_name ?? node.name,
            }
          }
        }

        indexer.upsertFact({
          factText,
          triplet,
          sourceKind: 'import_doc',
          sourceRef,
          confidence: 0.55,
        })
        segmentsUpserted += 1
        processedSegments += 1
        await yieldEvery(processedSegments, yieldStride)
      }
    }
  } finally {
    indexer.close()
    astDb?.close()
  }
  return { filesScanned, segmentsUpserted }
}
