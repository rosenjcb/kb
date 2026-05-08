import path from 'node:path'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { placeholderTripletFromFactText } from './fact-triplet-placeholder'
import { segmentMarkdownForFacts } from './sentence-split'

export interface ScanFactIngestInput {
  baseDir: string
  files: Record<string, string>
  /** Minimum segment length after trim; default 40 (matches document writer ingest). */
  minSegmentLength?: number
  /** Max long segments ingested per file; default 40. */
  maxPerFile?: number
  /** Global cap on upserts for this run; default 500. */
  maxTotal?: number
}

export interface ScanFactIngestResult {
  filesScanned: number
  segmentsUpserted: number
  segmentsSkippedShort: number
}

/**
 * Deterministic ingest: segment each markdown source → `facts` rows (`import_doc`, `sourceRef` path#sN).
 * Uses placeholder triplets (same policy as `SqliteDocumentWriter.indexFactsFromContent`). Idempotent
 * via `normalized_text` dedupe in `SqliteKbIndexer.upsertFact`.
 */
export function ingestSourceMarkdownFilesAsFacts(input: ScanFactIngestInput): ScanFactIngestResult {
  const minLen = input.minSegmentLength ?? 40
  const maxPerFile = input.maxPerFile ?? 40
  const maxTotal = input.maxTotal ?? 500
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  let filesScanned = 0
  let segmentsUpserted = 0
  let segmentsSkippedShort = 0
  let budget = maxTotal
  try {
    const paths = Object.keys(input.files).sort()
    for (const relPath of paths) {
      if (budget <= 0) break
      const raw = input.files[relPath]
      if (!raw?.trim()) continue
      filesScanned += 1
      const cleaned = segmentMarkdownForFacts(raw).map(s => s.replace(/\s+/g, ' ').trim())
      for (const s of cleaned) {
        if (s.length < minLen) segmentsSkippedShort += 1
      }
      const eligible = cleaned.filter(s => s.length >= minLen).slice(0, maxPerFile)
      let segIdx = 0
      for (const factText of eligible) {
        if (budget <= 0) break
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
        budget -= 1
      }
    }
  } finally {
    indexer.close()
  }
  return { filesScanned, segmentsUpserted, segmentsSkippedShort }
}
