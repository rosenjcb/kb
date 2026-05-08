import type { KbGraphWriter } from './kb-graph-writer'
import type { CodeGraphStore } from './code-graph-store'

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

/** Max expansion phrases from semantic graph (triplets + verbs + neighbor names). */
const MAX_SEMANTIC_EXPANSION = 18
/** Max symbol names appended from the code graph bridge. */
const MAX_CODE_EXPANSION = 8

export async function expandQueryWithGraph(
  query: string,
  graphWriter: KbGraphWriter,
  codeStore?: CodeGraphStore
): Promise<string> {
  try {
    const slugs = toGraphQuerySlugs(query)
    if (slugs.length === 0) return query

    const terms = await graphWriter.expandQuery(slugs)

    // Bridge into the code graph: find code symbols linked to the matched
    // semantic entities and append their names for lexical boosting.
    let codeTerms: string[] = []
    if (codeStore) {
      try {
        const codeNodes = codeStore.expandWithCodeNeighbors(slugs, MAX_CODE_EXPANSION)
        codeTerms = [...new Set(codeNodes.map(n => n.name))].slice(0, MAX_CODE_EXPANSION)
      } catch {
        // code graph expansion is best-effort
      }
    }

    const allTerms = [...terms.slice(0, MAX_SEMANTIC_EXPANSION), ...codeTerms]
    if (allTerms.length === 0) return query

    return `${query} ${allTerms.join(' ')}`
  } catch {
    return query
  }
}
