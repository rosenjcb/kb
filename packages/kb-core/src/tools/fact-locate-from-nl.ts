import type { LLMProvider } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import type { FactRow, SqliteKbIndexer } from './sqlite-kb-index'
import { toGraphQuerySlugs } from './graph-query-expansion'

type IndexerPick = Pick<
  SqliteKbIndexer,
  'searchFacts' | 'searchFactsByConcepts' | 'getActiveFactByTextMatch' | 'getActiveFactById'
>

function parseChosenFactId(text: string): string | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { chosenFactId?: unknown }
    const v = j.chosenFactId
    if (v === null || v === undefined) return null
    if (typeof v !== 'string') return null
    const id = v.trim()
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * Resolve a fact row from user natural language: exact id, exact normalized text,
 * then BM25 FTS + concept-based search merged and deduplicated, then LLM disambiguation.
 */
export async function locateFactRowFromNaturalLanguage(input: {
  indexer: IndexerPick
  userText: string
  llm?: LLMProvider
}): Promise<FactRow | undefined> {
  const q = input.userText.trim()
  if (!q) return undefined

  const idMatch = /^fact-[a-f0-9]+$/i.exec(q)
  if (idMatch) {
    const byId = input.indexer.getActiveFactById(q)
    if (byId) return byId
  }

  const exact = input.indexer.getActiveFactByTextMatch(q)
  if (exact) return exact

  if (!input.llm) return undefined

  // FTS search (BM25 relevance-ordered, stop-word filtered)
  const ftsCandidates = input.indexer.searchFacts(q, 15)

  // If FTS returns nothing (can happen with very long or stop-word-heavy inputs),
  // retry with just the most distinctive tokens as a short phrase.
  const shortPhrase = toGraphQuerySlugs(q).slice(0, 5).join(' ')
  const ftsFallback =
    ftsCandidates.length === 0 && shortPhrase
      ? input.indexer.searchFacts(shortPhrase, 15)
      : []

  // Concept/slug-based search as a complement — catches cases where FTS tokenization misses
  const slugs = toGraphQuerySlugs(q)
  const conceptCandidates = slugs.length > 0 ? input.indexer.searchFactsByConcepts(slugs, 15) : []

  // Merge: FTS results first (better relevance ordering), then fallback + concept hits
  const seen = new Set(ftsCandidates.map(c => c.id))
  const merged: FactRow[] = [...ftsCandidates]
  for (const c of [...ftsFallback, ...conceptCandidates]) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      merged.push(c)
    }
  }

  const candidates = merged.slice(0, 15)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  const systemPrompt = loadPrompt('fact-locate-from-candidates.md')
  const lines = candidates.map(
    (c, i) =>
      `${i + 1}. id=${c.id}\n   text: ${c.fact_text}\n   triple: (${c.subject}) [${c.predicate}] (${c.object})`
  )
  const res = await input.llm.call({
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `User reference (may paraphrase):\n"${q}"\n\nCandidates:\n\n${lines.join('\n\n')}\n`,
      },
    ],
    maxTokens: 120,
    temperature: 0,
  })
  const chosen = parseChosenFactId(res.text)
  if (!chosen) return undefined
  return candidates.find(c => c.id === chosen)
}
