import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { tombstoneDocFactsForFile } from './doc-fact-writer'
import { placeholderTripletFromFactText } from './fact-triplet-placeholder'
import { parseOkfDocument } from './okf'
import { segmentMarkdownForFacts } from './sentence-split'
import { yieldEvery } from './yield'

export interface ScanFactIngestInput {
  baseDir: string
  files: Record<string, string>
  yieldEverySegments?: number
  /** When true, look up the nearest exported AST symbol for each segment and attach a relatesTo triplet. */
  matchAstNodes?: boolean
  /** Repo slug — prefixes `source_ref` and tags the `git_repo` column (multi-repo provenance). */
  gitRepo?: string
  onProgress?: (progress: ScanFactIngestProgress) => void
}

export interface ScanFactIngestResult {
  filesScanned: number
  segmentsUpserted: number
  segmentsTombstoned: number
}

export interface ScanFactIngestProgress {
  filesConsidered: number
  filesCompleted: number
  filesRemaining: number
  filesScanned: number
  segmentsUpserted: number
  currentFile?: string
}

/** Extract FTS-safe tokens from fact text for facts_fts lookup. */
function ftsQueryFromText(text: string, maxTerms = 8): string {
  return text
    .split(/\W+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, maxTerms)
    .join(' OR ')
}

interface CodeFactRow {
  id: string
  subject: string
  object: string | null
}

/** Lowercased word tokens (≥3 chars, non-numeric) — same shape as `ftsQueryFromText` terms. */
function scopeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t))
}

interface ScopeCandidate {
  subject: string
  /** token → max weight it appears at (subject=3, object/fact_text=1). */
  weights: Map<string, number>
}

function buildScopeCandidate(row: { subject: string; object: string; fact_text: string }): ScopeCandidate {
  const weights = new Map<string, number>()
  const add = (text: string, w: number) => {
    for (const tok of scopeTokens(text)) {
      if ((weights.get(tok) ?? 0) < w) weights.set(tok, w)
    }
  }
  add(row.fact_text, 1)
  add(row.object, 1)
  add(row.subject, 3)
  return { subject: row.subject, weights }
}

/** Best in-scope symbol for a segment by weighted token overlap; null when nothing overlaps. */
function scoreSegmentInScope(segment: string, candidates: ScopeCandidate[]): ScopeCandidate | null {
  const segTokens = new Set(scopeTokens(segment))
  if (segTokens.size === 0) return null
  let best: ScopeCandidate | null = null
  let bestScore = 0
  for (const cand of candidates) {
    let score = 0
    for (const tok of segTokens) score += cand.weights.get(tok) ?? 0
    if (score > bestScore) {
      best = cand
      bestScore = score
    } else if (score === bestScore && score > 0 && best) {
      // Tie: prefer the more specific (shorter) symbol, then lexicographic for determinism.
      if (
        cand.subject.length < best.subject.length ||
        (cand.subject.length === best.subject.length && cand.subject < best.subject)
      ) {
        best = cand
      }
    }
  }
  return bestScore > 0 ? best : null
}

/**
 * Resolve an OKF `resource` (e.g. `./src/foo.ts` or `./src/core`) to the exported-symbol code
 * facts of that file/dir in the same repo, as scorable candidates. Returns null when it does not
 * resolve to known code (caller then falls back to the global nearest-symbol match). Code facts
 * use the `ast:<relPath>@<symbol>` source_ref convention (`code-graph-indexer.ts`).
 */
function resolveResourceScope(
  indexer: SqliteKbIndexer,
  docRelPath: string,
  resource: string,
  gitRepo: string | undefined
): ScopeCandidate[] | null {
  const normalized = resource.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('..')) return null

  const docDir = path.posix.dirname(docRelPath.replace(/\\/g, '/'))
  const candidatePaths = new Set<string>([normalized])
  const joined = path.posix.normalize(path.posix.join(docDir === '.' ? '' : docDir, normalized))
  if (joined && !joined.startsWith('..')) candidatePaths.add(joined)

  const sameRepo = (a: string | null) => (a ?? null) === (gitRepo ?? null)

  for (const p of candidatePaths) {
    // `ast:<path>@` selects a single file's symbols; `ast:<path>/` selects a directory's.
    for (const prefix of [`ast:${p}@`, `ast:${p}/`]) {
      const rows = indexer
        .listActiveFactsBySourceRefPrefix(prefix)
        .filter(f => f.predicate === 'exported_from' && f.tombstoned_at === null && sameRepo(f.git_repo))
      if (rows.length > 0) return rows.map(buildScopeCandidate)
    }
  }
  return null
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

  let astDb: DatabaseSync | null = null
  let findNearest: ((text: string) => CodeFactRow | null) | null = null

  if (input.matchAstNodes && existsSync(dbPath)) {
    try {
      astDb = new DatabaseSync(dbPath, { readOnly: true })
      const stmt = astDb.prepare(`
        SELECT f.id, f.subject, f.object
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.fact_id
        WHERE facts_fts MATCH ?
          AND f.source_kind = 'import_code'
          AND f.predicate = 'exported_from'
          AND f.tombstoned_at IS NULL
        ORDER BY rank
        LIMIT ?
      `)
      findNearest = (text: string) => {
        const q = ftsQueryFromText(text)
        if (!q) return null
        try {
          return (stmt.get(q, 1) as unknown as CodeFactRow | undefined) ?? null
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
  let segmentsTombstoned = 0
  let processedSegments = 0
  const yieldStride = input.yieldEverySegments ?? 50
  try {
    const paths = Object.keys(input.files).sort()
    for (const relPath of paths) {
      const raw = input.files[relPath]
      if (raw === undefined) continue
      filesScanned += 1
      // Namespace the source_ref by repo so two repos that both contain e.g. README.md don't
      // tombstone each other's facts (per-file tombstoning keys off source_ref).
      const refPath = input.gitRepo ? `${input.gitRepo}/${relPath}` : relPath
      segmentsTombstoned += tombstoneDocFactsForFile(indexer, refPath)
      if (!raw.trim()) continue
      const sourceLabel = path.basename(relPath, path.extname(relPath))

      // OKF resource scoping: when a doc names a code file/dir, anchor its segments to a symbol
      // from that file/dir only, instead of guessing against the global exported-symbol pool.
      const resource = input.matchAstNodes
        ? parseOkfDocument(raw).frontmatter?.resource
        : undefined
      const scope = resource
        ? resolveResourceScope(indexer, relPath, resource, input.gitRepo)
        : null

      const segments = segmentMarkdownForFacts(raw).map(s => s.replace(/\s+/g, ' ').trim())
      let segIdx = 0
      for (const factText of segments) {
        const sourceRef = `${refPath}#s${segIdx}`
        segIdx += 1

        let triplet = placeholderTripletFromFactText(factText)
        if (scope) {
          // Precise: match only against the resource's symbols, never the global pool.
          const match = scoreSegmentInScope(factText, scope)
          if (match) {
            triplet = { subject: sourceLabel, predicate: 'relatesTo', object: match.subject }
          }
        } else if (findNearest) {
          const node = findNearest(factText)
          if (node) {
            triplet = {
              subject: sourceLabel,
              predicate: 'relatesTo',
              object: node.subject,
            }
          }
        }

        indexer.upsertFact({
          factText,
          triplet,
          sourceKind: 'import_doc',
          sourceRef,
          confidence: 0.55,
          gitRepo: input.gitRepo,
        })
        segmentsUpserted += 1
        processedSegments += 1
        input.onProgress?.({
          filesConsidered: paths.length,
          filesCompleted: Math.max(filesScanned - 1, 0),
          filesRemaining: Math.max(paths.length - Math.max(filesScanned - 1, 0), 0),
          filesScanned,
          segmentsUpserted,
          currentFile: relPath,
        })
        await yieldEvery(processedSegments, yieldStride)
      }
      input.onProgress?.({
        filesConsidered: paths.length,
        filesCompleted: filesScanned,
        filesRemaining: Math.max(paths.length - filesScanned, 0),
        filesScanned,
        segmentsUpserted,
        currentFile: relPath,
      })
    }
  } finally {
    indexer.close()
    astDb?.close()
  }
  return { filesScanned, segmentsUpserted, segmentsTombstoned }
}
