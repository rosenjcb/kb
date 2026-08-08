import path from 'node:path'
import {
  type CodeSymbolRow,
  type DocCodeLinkInput,
  SqliteKbIndexer,
} from '../tools/sqlite-kb-index'
import { parseOkfDocument } from './okf'
import { createRateLimitedYielder, yieldEvery } from './yield'

export interface ScanDocumentIngestInput {
  baseDir: string
  files: Record<string, string>
  /** Count-based yield stride (also yields on a wall-clock timer — see yieldEveryMs). */
  yieldEveryFiles?: number
  /** Wall-clock yield interval so /healthz stays responsive when each file is slow. */
  yieldEveryMs?: number
  /** When true, link each document to the exported AST symbols it is about. */
  matchAstNodes?: boolean
  /** Repo slug — namespaces the document and tags the `git_repo` column. */
  gitRepo?: string
  onProgress?: (progress: ScanDocumentIngestProgress) => void
}

export interface ScanDocumentIngestResult {
  filesScanned: number
  documentsUpserted: number
  linksWritten: number
}

export interface ScanDocumentIngestProgress {
  filesConsidered: number
  filesCompleted: number
  filesRemaining: number
  filesScanned: number
  documentsUpserted: number
  linksWritten: number
  currentFile?: string
}

/** How many code symbols one document may link to. */
const LINK_TOP_K = 5

/** Only the head of a large document is used to pick its code links. */
const LINK_SCORING_MAX_CHARS = 8_000

/** Lowercased word tokens (≥3 chars, non-numeric) for deterministic symbol matching. */
function scopeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t))
}

interface ScopeCandidate {
  symbolId: string
  name: string
  /** token → max weight it appears at (name=3, path/source_text=1). */
  weights: Map<string, number>
}

function buildScopeCandidate(row: CodeSymbolRow): ScopeCandidate {
  const weights = new Map<string, number>()
  const add = (text: string, w: number) => {
    for (const tok of scopeTokens(text)) {
      if ((weights.get(tok) ?? 0) < w) weights.set(tok, w)
    }
  }
  add(row.source_text ?? '', 1)
  add(row.rel_path, 1)
  add(row.name, 3)
  return { symbolId: row.id, name: row.name, weights }
}

/** Top-`k` in-scope symbols for a document body by weighted token overlap. */
function scoreDocumentInScope(
  body: string,
  candidates: ScopeCandidate[],
  k: number
): Array<{ symbolId: string; score: number }> {
  const bodyTokens = new Set(scopeTokens(body.slice(0, LINK_SCORING_MAX_CHARS)))
  if (bodyTokens.size === 0) return []
  const scored: Array<{ symbolId: string; name: string; score: number }> = []
  for (const cand of candidates) {
    let score = 0
    for (const tok of bodyTokens) score += cand.weights.get(tok) ?? 0
    if (score > 0) scored.push({ symbolId: cand.symbolId, name: cand.name, score })
  }
  // Ties break toward the more specific (shorter) symbol name, then lexicographically,
  // so the same document always produces the same links.
  scored.sort(
    (a, b) =>
      b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name)
  )
  return scored.slice(0, k).map(({ symbolId, score }) => ({ symbolId, score }))
}

/**
 * Resolve an OKF `resource` (e.g. `./src/foo.ts` or `./src/core`) to the exported symbols of
 * that file/dir in the same repo, as scorable candidates. Returns null when it does not
 * resolve to known code — the caller then falls back to the global nearest-symbol match.
 */
function resolveResourceScope(
  indexer: SqliteKbIndexer,
  docRelPath: string,
  resource: string,
  gitRepo: string
): ScopeCandidate[] | null {
  const normalized = resource.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('..')) return null

  const docDir = path.posix.dirname(docRelPath.replace(/\\/g, '/'))
  const candidatePaths = new Set<string>([normalized])
  const joined = path.posix.normalize(path.posix.join(docDir === '.' ? '' : docDir, normalized))
  if (joined && !joined.startsWith('..')) candidatePaths.add(joined)

  for (const p of candidatePaths) {
    // An exact file path first, then the directory it names.
    for (const prefix of [p, `${p}/`]) {
      const rows = indexer.listCodeSymbolsByPathPrefix(prefix, gitRepo)
      if (rows.length > 0) return rows.map(buildScopeCandidate)
    }
  }
  return null
}

/** First markdown heading, else the file name. */
function documentTitle(relPath: string, body: string): string {
  for (const line of body.split('\n', 40)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/)
    if (heading?.[1]) return heading[1].trim().slice(0, 200)
  }
  return path.basename(relPath, path.extname(relPath))
}

/**
 * Deterministic ingest: each markdown source becomes one `documents` row (whole file, no
 * sentence splitting) plus its FTS entry. When `matchAstNodes` is true (requires the code
 * index to have run first), the document is also linked to up to {@link LINK_TOP_K} code
 * symbols via `doc_code_links` — an OKF `resource` scopes the match to one file/directory,
 * otherwise the symbols are drawn from an FTS lookup over the whole repo.
 */
export async function indexSourceMarkdownFilesAsDocuments(
  input: ScanDocumentIngestInput
): Promise<ScanDocumentIngestResult> {
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  const gitRepo = input.gitRepo ?? ''

  let filesScanned = 0
  let documentsUpserted = 0
  let linksWritten = 0
  const yieldStride = input.yieldEveryFiles ?? 5
  const maybeYieldByTime = createRateLimitedYielder(input.yieldEveryMs ?? 25)

  try {
    await indexer.runInTransaction(async () => {
      const paths = Object.keys(input.files).sort()
      for (const relPath of paths) {
        const raw = input.files[relPath]
        if (raw === undefined) continue
        filesScanned += 1
        if (!raw.trim()) {
          const stale = indexer.getDocumentByPath(gitRepo, relPath)
          if (stale) indexer.deleteDocument(stale.id)
          continue
        }

        const parsed = parseOkfDocument(raw)
        const title = parsed.frontmatter?.title?.trim() || documentTitle(relPath, parsed.body)
        const { id: docId } = indexer.upsertDocument({
          gitRepo,
          relPath,
          title,
          body: raw,
        })
        documentsUpserted += 1

        if (input.matchAstNodes) {
          const resource = parsed.frontmatter?.resource
          const scope = resource
            ? resolveResourceScope(indexer, relPath, resource, gitRepo)
            : null
          const links: DocCodeLinkInput[] = scope
            ? scoreDocumentInScope(`${title}\n${parsed.body}`, scope, LINK_TOP_K).map(hit => ({
                symbolId: hit.symbolId,
                score: hit.score,
                linkKind: 'documents',
              }))
            : indexer
                .searchCodeSymbolsFts(
                  `${title} ${parsed.body.slice(0, LINK_SCORING_MAX_CHARS)}`,
                  LINK_TOP_K
                )
                .map((row, rank) => ({
                  symbolId: row.id,
                  // FTS returns best-first; a decaying score preserves that order.
                  score: 1 / (rank + 1),
                  linkKind: 'relates_to',
                }))
          linksWritten += indexer.replaceDocCodeLinks(docId, links)
        }

        input.onProgress?.({
          filesConsidered: paths.length,
          filesCompleted: filesScanned,
          filesRemaining: Math.max(paths.length - filesScanned, 0),
          filesScanned,
          documentsUpserted,
          linksWritten,
          currentFile: relPath,
        })
        await yieldEvery(filesScanned, yieldStride)
        await maybeYieldByTime()
      }
    })
  } finally {
    indexer.close()
  }

  return { filesScanned, documentsUpserted, linksWritten }
}

/**
 * Delete indexed documents for markdown paths that are no longer present in the repo.
 * `current` is the full set of source files for `gitRepo`; anything indexed under that repo
 * but missing from it is removed.
 */
export function deleteRemovedDocuments(
  indexer: SqliteKbIndexer,
  current: Record<string, string>,
  gitRepo?: string
): number {
  const repo = gitRepo ?? ''
  const live = new Set(Object.keys(current).map(p => p.replace(/\\/g, '/')))
  let count = 0
  for (const row of indexer.listDocumentPathsByRepo(repo)) {
    if (live.has(row.rel_path)) continue
    if (indexer.deleteDocument(row.id)) count += 1
  }
  return count
}
