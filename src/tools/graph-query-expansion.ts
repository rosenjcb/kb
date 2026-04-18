import type { DuckGraphWriter } from './duck-graph-writer'

export function toGraphQuerySlugs(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
    .map(token => token.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)

  // Also generate bigrams so compound entity IDs like "api-key", "knowledge-graph",
  // "llm-provider" can be matched from multi-word query phrases.
  const bigrams: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]}-${tokens[i + 1]}`)
  }

  return [...new Set([...tokens, ...bigrams])].slice(0, 16)
}

export async function expandQueryWithGraph(
  query: string,
  graphWriter: DuckGraphWriter
): Promise<string> {
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
