/**
 * Shared helper for the TreeSitterIndexer to write code-derived facts into the
 * facts table and manage incremental file state.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { FactTriplet, SqliteKbIndexer } from './sqlite-kb-index.js'

export interface CodeFileStateRow {
  file_path: string
  content_hash: string
  extractor: string
  indexed_at: string
}

export function getCodeFileState(db: DatabaseSync, filePath: string): CodeFileStateRow | undefined {
  return db
    .prepare(
      'SELECT file_path, content_hash, extractor, indexed_at FROM code_file_state WHERE file_path = ?'
    )
    .get(filePath) as CodeFileStateRow | undefined
}

export function upsertCodeFileState(
  db: DatabaseSync,
  filePath: string,
  contentHash: string,
  extractor: string
): void {
  db.prepare(`
    INSERT INTO code_file_state (file_path, content_hash, extractor, indexed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      extractor = excluded.extractor,
      indexed_at = excluded.indexed_at
  `).run(filePath, contentHash, extractor, new Date().toISOString())
}

export function upsertCodeFileFact(
  indexer: SqliteKbIndexer,
  sourceRef: string,
  factText: string,
  triplet: FactTriplet,
  confidence: number,
  sourceText?: string,
  gitRepo?: string
): 'inserted' | 'updated' {
  const r = indexer.upsertFact({
    factText,
    triplet,
    sourceKind: 'import_code',
    sourceRef,
    confidence,
    sourceText,
    gitRepo,
  })
  return r.operation
}

/**
 * Explicitly wire every `imports` fact to the `exported_from` facts for the same
 * file path. Call once after all code facts have been written — this is a
 * deterministic structural pass, not token-similarity inference.
 */
export function relinkImportCodeEdges(indexer: SqliteKbIndexer): number {
  return indexer.relinkCodeImportEdges()
}

export function tombstoneStaleCodeFacts(
  indexer: SqliteKbIndexer,
  currentSourceRefs: Set<string>,
  gitRepo?: string
): number {
  const existing = indexer.listActiveFactsBySourceRefPrefix('ast:')
  let count = 0
  for (const fact of existing) {
    // Multi-repo: only reconcile stale facts for the repo being indexed, so re-indexing
    // one repo never tombstones another repo's code facts (scoped by the git_repo column).
    if (gitRepo !== undefined && fact.git_repo !== gitRepo) continue
    if (fact.source_ref && !currentSourceRefs.has(fact.source_ref)) {
      indexer.tombstoneFactById(fact.id)
      count++
    }
  }
  return count
}

/**
 * Recover the repo-relative file path a per-file AST fact belongs to, or `null` when the
 * ref is not file-scoped. Symbol/export facts are `ast:<rel>@<name>` and constant facts are
 * `ast:const:<rel>@<name>`, so the path is the segment before the final `@`. Import and
 * heritage edges (`ast:import:<sha1>`, `ast:edge:<sha1>`) hash the path away and cannot be
 * mapped back to a single file — they return `null`.
 */
function codeFactRelPath(sourceRef: string): string | null {
  if (sourceRef.startsWith('ast:import:') || sourceRef.startsWith('ast:edge:')) return null
  let body: string
  if (sourceRef.startsWith('ast:const:')) body = sourceRef.slice('ast:const:'.length)
  else if (sourceRef.startsWith('ast:')) body = sourceRef.slice('ast:'.length)
  else return null
  const at = body.lastIndexOf('@')
  if (at <= 0) return null
  return body.slice(0, at)
}

/**
 * Tombstone code facts for files that were removed since the last per-repo AST manifest.
 * Used on a PARTIAL incremental rescan, where {@link tombstoneStaleCodeFacts} cannot be used
 * (the current source-ref set only covers changed files, so it would wrongly purge every
 * unchanged file's facts). Scoped by `gitRepo` and matched by parsed file path — never by a
 * LIKE prefix — so no other repo or `_`-bearing sibling path can be caught by accident.
 *
 * Caveat: hashed import/heritage edges (`ast:import:*` / `ast:edge:*`) for a removed file are
 * not file-mappable and remain active until the next full re-index reconciles them.
 */
export function tombstoneRemovedCodeFiles(
  indexer: SqliteKbIndexer,
  removedRelPaths: string[],
  gitRepo?: string
): number {
  if (removedRelPaths.length === 0) return 0
  const removed = new Set(removedRelPaths)
  const existing = indexer.listActiveFactsBySourceRefPrefix('ast:')
  let count = 0
  for (const fact of existing) {
    if (gitRepo !== undefined && fact.git_repo !== gitRepo) continue
    if (!fact.source_ref) continue
    const rel = codeFactRelPath(fact.source_ref)
    if (rel !== null && removed.has(rel) && indexer.tombstoneFactById(fact.id)) count++
  }
  return count
}
