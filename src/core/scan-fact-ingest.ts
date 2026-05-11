import path from 'node:path'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { placeholderTripletFromFactText } from './fact-triplet-placeholder'
import { segmentMarkdownForFacts } from './sentence-split'
import { yieldEvery } from './yield'

export interface ScanFactIngestInput {
  baseDir: string
  files: Record<string, string>
  yieldEverySegments?: number
}

export interface ScanFactIngestResult {
  filesScanned: number
  segmentsUpserted: number
}

/**
 * Deterministic ingest: segment each markdown source → `facts` rows (`import_doc`, `sourceRef` path#sN).
 * Uses placeholder triplets (same policy as `SqliteDocumentWriter.indexFactsFromContent`). Idempotent
 * via `normalized_text` dedupe in `SqliteKbIndexer.upsertFact`.
 */
export async function ingestSourceMarkdownFilesAsFacts(
  input: ScanFactIngestInput
): Promise<ScanFactIngestResult> {
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
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
      const segments = segmentMarkdownForFacts(raw).map(s => s.replace(/\s+/g, ' ').trim())
      let segIdx = 0
      for (const factText of segments) {
        const sourceRef = `${relPath}#s${segIdx}`
        segIdx += 1
        indexer.upsertFact({
          factText,
          triplet: placeholderTripletFromFactText(factText),
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
  }
  return { filesScanned, segmentsUpserted }
}
