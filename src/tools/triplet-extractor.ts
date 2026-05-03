import { loadPrompt } from '../prompts/loader'
import type { LLMProvider } from '../core/types'
import type { FactTriplet } from './sqlite-kb-index'

function parseTripletJson(text: string): FactTriplet {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('triplet-extract: no JSON object in model output')
  const j = JSON.parse(m[0]) as { subject?: unknown; predicate?: unknown; object?: unknown }
  const subject = typeof j.subject === 'string' ? j.subject.trim() : ''
  const predicate = typeof j.predicate === 'string' ? j.predicate.trim() : ''
  const object = typeof j.object === 'string' ? j.object.trim() : ''
  if (!subject || !predicate || !object) {
    throw new Error(`triplet-extract: incomplete triple ${JSON.stringify(j)}`)
  }
  return { subject, predicate, object }
}

/** LLM: one sentence → explicit (subject, predicate, object). */
export async function extractFactTriplet(llm: LLMProvider, sentence: string): Promise<FactTriplet> {
  const systemPrompt = loadPrompt('fact-triplet-extract.md')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: `Sentence:\n${sentence.trim()}` }],
    maxTokens: 256,
    temperature: 0,
  })
  return parseTripletJson(res.text)
}
