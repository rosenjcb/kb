import type { DuckGraphWriter } from './duck-graph-writer'

export function toGraphQuerySlugs(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
    .map(token => token.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .slice(0, 8)
}

export async function expandQueryWithGraph(query: string, graphWriter: DuckGraphWriter): Promise<string> {
  try {
    const slugs = toGraphQuerySlugs(query)
    if (slugs.length === 0) return query

    const neighbors = await graphWriter.expandQuery(slugs)
    if (neighbors.length === 0) return query

    return `${query} ${neighbors.slice(0, 5).join(' ')}`
  } catch {
    return query
  }
}
