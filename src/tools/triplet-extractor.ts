import type { LLMProvider } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import type { FactTriplet } from './sqlite-kb-index'

function parseTripletRow(j: unknown): FactTriplet | null {
  if (!j || typeof j !== 'object') return null
  const r = j as { subject?: unknown; predicate?: unknown; object?: unknown }
  const subject = typeof r.subject === 'string' ? r.subject.trim() : ''
  const predicate = typeof r.predicate === 'string' ? r.predicate.trim() : ''
  const object = typeof r.object === 'string' ? r.object.trim() : ''
  if (!subject || !predicate || !object) return null
  return { subject, predicate, object }
}

function parseTripletJsonArray(text: string): FactTriplet[] {
  // Accept either an array [...] or a bare object {...} for backwards compat
  const arrMatch = text.match(/\[[\s\S]*\]/)
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (!arrMatch && !objMatch) throw new Error('triplet-extract: no JSON in model output')

  if (arrMatch) {
    const parsed = JSON.parse(arrMatch[0]) as unknown[]
    const rows = parsed.map(parseTripletRow).filter((r): r is FactTriplet => r !== null)
    if (rows.length === 0) throw new Error('triplet-extract: array contained no valid triples')
    return rows
  }

  // Bare object fallback
  const objStr = objMatch?.[0]
  if (!objStr) throw new Error('triplet-extract: no JSON in model output')
  const row = parseTripletRow(JSON.parse(objStr))
  if (!row) throw new Error('triplet-extract: incomplete triple in model output')
  return [row]
}

/** LLM: one or more sentences → array of (subject, predicate, object) triples. */
export async function extractFactTriplets(llm: LLMProvider, text: string): Promise<FactTriplet[]> {
  const systemPrompt = loadPrompt('fact-triplet-extract.md')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: `Input:\n${text.trim()}` }],
    maxTokens: 512,
    temperature: 0,
  })
  return parseTripletJsonArray(res.text)
}

/** Convenience: extract a single triplet (first of potentially many). */
export async function extractFactTriplet(llm: LLMProvider, sentence: string): Promise<FactTriplet> {
  const triplets = await extractFactTriplets(llm, sentence)
  const first = triplets[0]
  if (!first) throw new Error('triplet-extract: no triplets returned')
  return first
}
