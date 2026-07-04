import type { DatabaseSync } from 'node:sqlite'

export interface RelationalConceptPair {
  phraseA: string
  phraseB: string
}

function cleanConceptPhrase(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[`"'«»]/g, '')
    .trim()
    .slice(0, 120)
}

/**
 * Detects natural-language questions that name two concepts and ask how they connect.
 * Attaches graph path context for relational questions; failures must not affect retrieval.
 */
export function parseRelationalConceptPair(query: string): RelationalConceptPair | null {
  const q = query.trim()
  if (q.length < 8) return null

  const patterns = [
    /how\s+(?:does|do)\s+(.+?)\s+relate\s+(?:to|with)\s+(.+?)(?:\s*[?.!])?\s*$/i,
    /how\s+is\s+(.+?)\s+connected\s+to\s+(.+?)(?:\s*[?.!])?\s*$/i,
    /relationship\s+between\s+(.+?)\s+and\s+(.+?)(?:\s*[?.!])?\s*$/i,
    /(?:what|which)\s+is\s+the\s+(?:link|connection|path)\s+between\s+(.+?)\s+and\s+(.+?)(?:\s*[?.!])?\s*$/i,
    /path\s+from\s+(.+?)\s+to\s+(.+?)(?:\s*[?.!])?\s*$/i,
  ]

  for (const re of patterns) {
    const m = q.match(re)
    if (!m?.[1] || !m?.[2]) continue
    const phraseA = cleanConceptPhrase(m[1])
    const phraseB = cleanConceptPhrase(m[2])
    if (!phraseA || !phraseB) continue
    if (phraseA.toLowerCase() === phraseB.toLowerCase()) continue
    return { phraseA, phraseB }
  }
  return null
}

interface FactsEdge {
  subject: string
  predicate: string
  object: string
}

interface FactsPathResult {
  nodes: string[]
  edgeLabels: string[]
}

/**
 * BFS through facts triplets (subject→object, bidirectional) to find a path between two terms.
 */
export function findFactsPath(
  db: DatabaseSync,
  a: string,
  b: string,
  maxHops = 5
): FactsPathResult | null {
  try {
    const edges = db
      .prepare(
        `SELECT DISTINCT subject, predicate, object FROM facts
         WHERE tombstoned_at IS NULL
           AND predicate != 'asserts'
           AND subject != 'kb'
         LIMIT 5000`
      )
      .all() as unknown as FactsEdge[]

    // Build bidirectional adjacency map (lowercase keys)
    const adjacency = new Map<string, Array<{ neighbor: string; label: string }>>()
    const addEdge = (from: string, to: string, label: string) => {
      const fromLower = from.toLowerCase()
      const toLower = to.toLowerCase()
      if (!adjacency.has(fromLower)) adjacency.set(fromLower, [])
      if (!adjacency.has(toLower)) adjacency.set(toLower, [])
      adjacency.get(fromLower)?.push({ neighbor: toLower, label })
      adjacency.get(toLower)?.push({ neighbor: fromLower, label })
    }

    for (const edge of edges) {
      if (edge.subject && edge.object) {
        addEdge(edge.subject, edge.object, edge.predicate)
      }
    }

    const startKey = a.toLowerCase()
    const endKey = b.toLowerCase()

    if (!adjacency.has(startKey) || !adjacency.has(endKey)) return null
    if (startKey === endKey) return { nodes: [a], edgeLabels: [] }

    // BFS
    interface BfsNode {
      key: string
      path: string[]
      labels: string[]
    }

    const queue: BfsNode[] = [{ key: startKey, path: [startKey], labels: [] }]
    const visited = new Set<string>([startKey])

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) break
      if (current.path.length > maxHops + 1) break

      const neighbors = adjacency.get(current.key) ?? []
      for (const { neighbor, label } of neighbors) {
        if (visited.has(neighbor)) continue
        const newPath = [...current.path, neighbor]
        const newLabels = [...current.labels, label]

        if (neighbor === endKey) {
          // Reconstruct with original casing from edges
          return { nodes: newPath, edgeLabels: newLabels }
        }

        visited.add(neighbor)
        queue.push({ key: neighbor, path: newPath, labels: newLabels })
      }
    }

    return null
  } catch {
    return null
  }
}

export function formatGraphRelationBlockForPair(
  db: DatabaseSync,
  pair: RelationalConceptPair
): string {
  const { phraseA: a, phraseB: b } = pair
  let result = findFactsPath(db, a, b)
  if (!result) {
    result = findFactsPath(db, b, a)
  }
  if (!result || result.nodes.length === 0) {
    return `KB graph: no directed path found between "${a}" and "${b}" within the configured hop limit (entities may be missing or only weakly linked).`
  }

  const hops = result.edgeLabels.length
  const edgeLines: string[] = []
  for (let i = 0; i < result.nodes.length - 1; i++) {
    const left = result.nodes[i]
    const right = result.nodes[i + 1]
    const label = result.edgeLabels[i] ?? '?'
    if (!left || !right) continue
    edgeLines.push(`  ${left} -[${label}]-> ${right}`)
  }

  const hopWord = hops === 1 ? 'hop' : 'hops'
  return [
    `Shortest directed path (${hops} ${hopWord}): ${result.nodes.join(' → ')}`,
    'Typed edges along that path:',
    ...edgeLines,
  ].join('\n')
}

/**
 * When the question matches a two-concept relational pattern, returns a short graph summary
 * for LLM grounding. Returns null when the question is not treated as relational.
 */
export function formatGraphRelationBlockFromQuestion(
  db: DatabaseSync,
  query: string
): string | null {
  const pair = parseRelationalConceptPair(query)
  if (!pair) return null
  return formatGraphRelationBlockForPair(db, pair)
}
