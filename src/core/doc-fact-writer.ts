import {
  diffRemovedSourceFiles,
  type SourceFilesManifest,
} from '../cli/init-source-files-manifest'
import type { SqliteKbIndexer } from '../tools/sqlite-kb-index'

/** `source_ref` prefix for segmented markdown facts (`README.md#s0`, …). */
export function docFactSourceRefPrefix(relPath: string): string {
  return `${relPath}#`
}

/**
 * Remove all active `import_doc` facts segmented from a markdown file.
 * Call before re-ingesting that file so removed/rewritten sentences do not linger.
 */
export function tombstoneDocFactsForFile(indexer: SqliteKbIndexer, relPath: string): number {
  const prefix = docFactSourceRefPrefix(relPath)
  const existing = indexer.listActiveFactsBySourceRefPrefix(prefix)
  let count = 0
  for (const fact of existing) {
    if (fact.source_kind !== 'import_doc') continue
    if (!fact.source_ref?.startsWith(prefix)) continue
    if (indexer.tombstoneFactById(fact.id)) count += 1
  }
  return count
}

/** Tombstone segmented doc facts for markdown paths removed since the last manifest. */
export function tombstoneRemovedDocSourceFiles(
  indexer: SqliteKbIndexer,
  current: Record<string, string>,
  manifest: SourceFilesManifest,
  gitRepo?: string
): number {
  let count = 0
  for (const relPath of diffRemovedSourceFiles(current, manifest)) {
    const refPath = gitRepo ? `${gitRepo}/${relPath}` : relPath
    count += tombstoneDocFactsForFile(indexer, refPath)
  }
  return count
}
