import type { LLMProvider } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import type { FactRow, SqliteKbIndexer } from './sqlite-kb-index'

type IndexerPick = Pick<
  SqliteKbIndexer,
  'searchFacts' | 'getActiveFactByTextMatch' | 'getActiveFactById'
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
 * else FTS candidates + LLM disambiguation.
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

  const candidates = input.indexer.searchFacts(q, 15)
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
