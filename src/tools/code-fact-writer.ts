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
