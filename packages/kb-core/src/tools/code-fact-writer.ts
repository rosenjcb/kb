/**
 * Shared helper for the TreeSitterIndexer to write exported AST symbols into the
 * `code_symbols` table and manage incremental file state.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { SqliteKbIndexer } from './sqlite-kb-index.js'

export interface CodeFileStateRow {
  file_path: string
  content_hash: string
  extractor: string
  indexed_at: string
}

/** Stable identity of one extracted symbol within a repo: `<relPath>@<name>`. */
export function codeSymbolKey(relPath: string, name: string): string {
  return `${relPath}@${name}`
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

export function upsertCodeSymbol(
  indexer: SqliteKbIndexer,
  relPath: string,
  name: string,
  kind: string,
  sourceText?: string,
  gitRepo?: string
): 'inserted' | 'updated' {
  const result = indexer.upsertCodeSymbol({
    relPath,
    name,
    kind,
    ...(sourceText ? { sourceText } : {}),
    ...(gitRepo !== undefined ? { gitRepo } : {}),
  })
  return result.operation
}

/**
 * Delete symbols for the repo that this run did not re-extract. Only safe after a FULL index,
 * where `currentKeys` covers every file in the repo — a partial rescan must use
 * {@link deleteRemovedCodeFiles} instead.
 */
export function deleteStaleCodeSymbols(
  indexer: SqliteKbIndexer,
  currentKeys: Set<string>,
  gitRepo?: string
): number {
  const repo = gitRepo ?? ''
  let count = 0
  for (const row of indexer.listCodeSymbolKeysByRepo(repo)) {
    if (currentKeys.has(codeSymbolKey(row.rel_path, row.name))) continue
    if (indexer.deleteCodeSymbol(row.id)) count++
  }
  return count
}

/**
 * Delete symbols for files removed since the last per-repo AST manifest. Used on a PARTIAL
 * incremental rescan, where {@link deleteStaleCodeSymbols} cannot be used (the current key set
 * only covers changed files, so it would wrongly purge every unchanged file's symbols).
 */
export function deleteRemovedCodeFiles(
  indexer: SqliteKbIndexer,
  removedRelPaths: string[],
  gitRepo?: string
): number {
  if (removedRelPaths.length === 0) return 0
  const repo = gitRepo ?? ''
  let count = 0
  for (const relPath of new Set(removedRelPaths)) {
    count += indexer.deleteCodeSymbolsForFile(repo, relPath)
  }
  return count
}
