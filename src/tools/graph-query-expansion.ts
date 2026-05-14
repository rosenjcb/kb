import path from 'node:path'
import type Database from 'better-sqlite3'

export function kbIndexDbPath(baseDir: string): string {
  return path.join(baseDir, '.kb-index.sqlite')
}

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

/** Max expansion phrases from facts graph (subject/object terms). */
const MAX_SEMANTIC_EXPANSION = 18
/** Max symbol names appended from the code graph. */
const MAX_CODE_EXPANSION = 8

/**
 * Expand a query string using:
 *   1. FTS on kg_nodes_fts → get matching exported symbol names, traverse kg_edges for neighbors
 *   2. LIKE-scan facts where subject or object matches slug (excluding placeholder 'asserts' rows)
 *
 * Synchronous — no async needed.
 */
export function expandQueryWithGraph(query: string, db: Database.Database): string {
  try {
    const slugs = toGraphQuerySlugs(query)
    if (slugs.length === 0) return query

    const seen = new Set<string>()
    const terms: string[] = []

    const add = (token: string) => {
      const t = token.trim()
      if (!t) return
      const key = t.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      terms.push(t)
    }

    // 1. FTS on kg_nodes_fts → find exported symbol names matching slugs, then get neighbors via kg_edges
    try {
      const ftsQuery = slugs.join(' OR ')
      const symbolRows = db
        .prepare(
          `SELECT DISTINCT n.name FROM kg_nodes_fts f
           JOIN kg_nodes n ON n.id = f.id
           WHERE kg_nodes_fts MATCH ? AND n.exported = 1
           LIMIT 20`
        )
        .all(ftsQuery) as Array<{ name: string }>

      for (const row of symbolRows) {
        add(row.name)
      }

      // Traverse kg_edges for neighbors of matched symbols
      if (symbolRows.length > 0) {
        const symbolNames = symbolRows.map(r => r.name)
        const placeholders = symbolNames.map(() => '?').join(', ')
        const neighborRows = db
          .prepare(
            `SELECT DISTINCT n2.name
             FROM kg_nodes n1
             JOIN kg_edges e ON e.from_id = n1.id OR e.to_id = n1.id
             JOIN kg_nodes n2 ON (e.from_id = n2.id OR e.to_id = n2.id) AND n2.id != n1.id
             WHERE n1.name IN (${placeholders}) AND n2.exported = 1
             LIMIT 20`
          )
          .all(...symbolNames) as Array<{ name: string }>
        for (const row of neighborRows) {
          add(row.name)
        }
      }
    } catch {
      // code graph expansion is best-effort
    }

    // 2. LIKE-scan facts for subject/object matching each slug
    try {
      for (const slug of slugs) {
        const pattern = `%${slug}%`
        const factRows = db
          .prepare(
            `SELECT subject, object FROM facts
             WHERE tombstoned_at IS NULL
               AND predicate != 'asserts'
               AND subject != 'kb'
               AND (LOWER(subject) LIKE ? OR LOWER(object) LIKE ?)
             LIMIT 30`
          )
          .all(pattern, pattern) as Array<{ subject: string; object: string }>

        for (const row of factRows) {
          if (row.subject && LOWER_SLUG_MATCHES(row.subject, slug)) {
            add(row.object)
          }
          if (row.object && LOWER_SLUG_MATCHES(row.object, slug)) {
            add(row.subject)
          }
        }
      }
    } catch {
      // facts expansion is best-effort
    }

    const allTerms = terms.slice(0, MAX_SEMANTIC_EXPANSION + MAX_CODE_EXPANSION)
    if (allTerms.length === 0) return query

    return `${query} ${allTerms.join(' ')}`
  } catch {
    return query
  }
}

function LOWER_SLUG_MATCHES(text: string, slug: string): boolean {
  return text.toLowerCase().includes(slug)
}
