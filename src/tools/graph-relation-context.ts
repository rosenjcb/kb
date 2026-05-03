import type { KbGraphWriter } from './kb-graph-writer'

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
 * Used only to attach optional graph path context; failures must never affect retrieval.
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

export async function formatGraphRelationBlockForPair(
  writer: KbGraphWriter,
  pair: RelationalConceptPair
): Promise<string> {
  const { phraseA: a, phraseB: b } = pair
  let path = await writer.findPath(a, b)
  if (!path) {
    path = await writer.findPath(b, a)
  }
  if (!path || path.nodes.length === 0) {
    return `KB graph: no directed path found between “${a}” and “${b}” within the configured hop limit (entities may be missing or only weakly linked).`
  }

  const labels: string[] = []
  for (const id of path.nodes) {
    labels.push(await writer.getEntityNameById(id))
  }

  const edgeLines: string[] = []
  for (let i = 0; i < path.nodes.length - 1; i++) {
    const fromN = path.nodes[i]
    const toN = path.nodes[i + 1]
    if (!fromN || !toN) continue
    const types = await writer.getDirectedEdgeLabelsBetween(fromN, toN)
    const typeStr = types.length === 0 ? '?' : types.join(' / ')
    const left = labels[i] ?? fromN
    const right = labels[i + 1] ?? toN
    edgeLines.push(`  ${left} -[${typeStr}]-> ${right}`)
  }

  const hopWord = path.hops === 1 ? 'hop' : 'hops'
  return [
    `Shortest directed path (${path.hops} ${hopWord}): ${labels.join(' → ')}`,
    'Typed edges along that path:',
    ...edgeLines,
  ].join('\n')
}

/**
 * When the question matches a two-concept relational pattern, returns a short graph summary
 * for LLM grounding. Returns null when the question is not treated as relational.
 */
export async function formatGraphRelationBlockFromQuestion(
  writer: KbGraphWriter,
  query: string
): Promise<string | null> {
  const pair = parseRelationalConceptPair(query)
  if (!pair) return null
  return formatGraphRelationBlockForPair(writer, pair)
}
