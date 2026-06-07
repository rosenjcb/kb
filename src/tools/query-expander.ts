import type { LLMProvider } from '../core/types'
import { loadPrompt } from '../prompts/loader'

const EXPANSION_STOP_WORDS = new Set([
  'what',
  'where',
  'when',
  'which',
  'who',
  'why',
  'how',
  'does',
  'do',
  'did',
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'about',
  'that',
  'this',
  'are',
  'is',
  'was',
  'were',
  'tell',
  'me',
  'give',
  'show',
  'list',
  'find',
  'main',
  'any',
  'all',
  'can',
  'has',
  'have',
  'its',
  'their',
])

/** True when the query has too few meaningful tokens for targeted FTS retrieval. */
export function shouldExpandQuery(query: string): boolean {
  return tokenizeMeaningful(query).length <= 2
}

/** LLM: rewrite a generic query into up to 4 targeted sub-query strings. */
export async function expandQuery(llm: LLMProvider, query: string): Promise<string[]> {
  const systemPrompt = loadPrompt('query-expand.md')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: `Query: ${query.trim()}` }],
    maxTokens: 256,
    temperature: 0,
  })
  return parseExpansionArray(res.text)
}

function parseExpansionArray(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as unknown[]
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, 4)
  } catch {
    return []
  }
}

function tokenizeMeaningful(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !EXPANSION_STOP_WORDS.has(t))
}
