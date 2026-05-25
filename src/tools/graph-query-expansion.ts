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
 *   1. FTS on facts_fts (source_kind=import_code) → exported symbol names, 1-hop via fact_edges
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

    // 1. FTS on facts_fts → find exported symbol names, then get neighbors via fact_edges
    try {
      const ftsQuery = slugs.join(' OR ')
      const symbolRows = db
        .prepare(
          `SELECT DISTINCT f.subject, f.id FROM facts_fts fts
           JOIN facts f ON f.id = fts.fact_id
           WHERE facts_fts MATCH ?
             AND f.source_kind = 'import_code'
             AND f.predicate = 'exported_from'
             AND f.tombstoned_at IS NULL
           LIMIT 20`
        )
        .all(ftsQuery) as Array<{ subject: string; id: string }>

      for (const row of symbolRows) {
        add(row.subject)
      }

      // 1-hop via fact_edges to get neighbor symbol names
      if (symbolRows.length > 0) {
        const factIds = symbolRows.map(r => r.id)
        const placeholders = factIds.map(() => '?').join(', ')
        const neighborRows = db
          .prepare(
            `SELECT DISTINCT f2.subject
             FROM fact_edges fe
             JOIN facts f2 ON f2.id = fe.to_fact_id
             WHERE fe.from_fact_id IN (${placeholders})
               AND f2.source_kind = 'import_code'
               AND f2.tombstoned_at IS NULL
             LIMIT 20`
          )
          .all(...factIds) as Array<{ subject: string }>
        for (const row of neighborRows) {
          add(row.subject)
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
             WHERE                predicate != 'asserts'
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
