import type { FactTriplet } from '../tools/sqlite-kb-index'

/** Fallback triple when no LLM triplet extraction is available (e.g. tests, doc import). */
export function placeholderTripletFromFactText(factText: string): FactTriplet {
  const o = factText.trim().replace(/\s+/g, ' ').slice(0, 400) || 'unspecified'
  return { subject: 'kb', predicate: 'asserts', object: o }
}
