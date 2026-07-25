/**
 * Bounded-memory batch sizing for cold-indexing large repos (see issue #191).
 *
 * `KB_EMBED_FETCH_PAGE_SIZE` caps how many not-yet-embedded fact rows
 * `SqliteKbIndexer.embedAllFacts` pulls into memory at once. Malformed/unset
 * values silently fall back to the default rather than failing indexing.
 */

const DEFAULT_EMBED_FETCH_PAGE_SIZE = 1000

export function resolveEmbedFetchPageSize(
  value: string | undefined = process.env.KB_EMBED_FETCH_PAGE_SIZE
): number {
  if (!value) return DEFAULT_EMBED_FETCH_PAGE_SIZE
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBED_FETCH_PAGE_SIZE
}
