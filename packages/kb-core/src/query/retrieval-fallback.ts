import type { ReadDocumentsResultItem } from './intent-cli.js'
import { toSource } from '../service/serialize.js'
import { DEFAULT_SOURCE_LIMIT, groupSources } from '../service/source-grouping.js'

/** Human footer cap for `sources>` — highest-ranked cited *files*. */
export const TOP_SOURCE_PREVIEW_LIMIT = DEFAULT_SOURCE_LIMIT

/** Compact `path (symbol, …)` citation for one grouped file. */
function formatSourceRef(source: { path: string; symbols: string[] }): string {
  return source.symbols.length > 0 ? `${source.path} (${source.symbols.join(', ')})` : source.path
}

/**
 * Terminal `sources>` value — the ranked *files* (not raw facts), deduped by path
 * with their fact subjects folded in, capped at {@link TOP_SOURCE_PREVIEW_LIMIT}.
 * Non-openable refs (`fact://` ids, `edge:<sha>`) are dropped by `groupSources`.
 */
export function formatReadDocumentSourcesPreview(
  results: ReadDocumentsResultItem[] | undefined
): string {
  if (!Array.isArray(results) || results.length === 0) return '(none)'

  // Group without a ceiling to count distinct files, then show the top N.
  const allFiles = groupSources(results.map(toSource), { maxSources: Number.MAX_SAFE_INTEGER })
  if (allFiles.length === 0) return '(none)'

  const shown = allFiles.slice(0, TOP_SOURCE_PREVIEW_LIMIT)
  const refs = shown.map(formatSourceRef).join('; ')
  if (allFiles.length <= TOP_SOURCE_PREVIEW_LIMIT) {
    return `all ${allFiles.length} file(s): ${refs}`
  }
  return `top ${shown.length} of ${allFiles.length} file(s): ${refs}`
}
