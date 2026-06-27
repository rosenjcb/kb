/** Full-fidelity fact payloads for LLM answer synthesis. */

/** Default per-fact body cap before LLM synthesis (query + chat evidence blocks). */
export const MAX_FACT_CONTENT_CHARS = 2000

export interface RetrievedFactForLLM {
  metadata?: { id?: string; title?: string }
  content?: string
  graphEvidence?: string[]
}

/** Every ranked retrieval result is eligible for LLM context (recall-first policy). */
export function factsForLLMContext<T extends RetrievedFactForLLM>(
  results: T[] | undefined | null
): T[] {
  if (!Array.isArray(results)) return []
  return results
}

export function formatFactContentForLLM(content: string | undefined, maxChars?: number): string {
  const text = (content ?? '').trim()
  if (!text) return 'No content available.'
  if (maxChars && text.length > maxChars) return `${text.slice(0, maxChars)}…`
  return text
}

export function formatRetrievedFactsForLLM(
  results: RetrievedFactForLLM[] | undefined | null,
  options?: {
    heading?: (item: RetrievedFactForLLM, index: number) => string
    /** Truncate each fact's content to this many characters before sending to the LLM. */
    maxContentChars?: number
  }
): string {
  const facts = factsForLLMContext(results)
  if (facts.length === 0) {
    return 'No evidence retrieved from KB documents.'
  }

  const sections: string[] = []
  for (const [index, fact] of facts.entries()) {
    const id = fact.metadata?.id ?? `fact-${index + 1}`
    const title = fact.metadata?.title?.trim()
    // Evidence is framed as plain knowledge, NOT as enumerated/citable items: no "Fact N"
    // label and no "(id=...)" suffix. Exposing those tokens makes the synthesizer echo them
    // back as "(fact 1)" inline refs or a trailing citations list. Provenance/citations are
    // carried in result metadata and surfaced separately, never in the answer body.
    const heading = options?.heading?.(fact, index) ?? (title && title !== id ? title : '')
    const body = formatFactContentForLLM(fact.content, options?.maxContentChars)
    sections.push(heading ? `${heading}\n${body}` : body)
  }

  const graphBlock = formatGraphEvidenceBlock(facts)
  if (graphBlock) sections.push(graphBlock)

  return sections.join('\n\n')
}

export function formatGraphEvidenceBlock(facts: RetrievedFactForLLM[]): string {
  const graphHints = new Set<string>()
  for (const fact of facts) {
    for (const line of fact.graphEvidence ?? []) {
      if (line.trim()) graphHints.add(line.trim())
    }
  }
  if (graphHints.size === 0) return ''
  return `Graph linkage hints (typed edges in the KB graph; must agree with document text above):\n${[...graphHints].map(h => `- ${h}`).join('\n')}`
}

export function formatToolQueryFactsForLLM(
  results: RetrievedFactForLLM[],
  maxContentChars: number = MAX_FACT_CONTENT_CHARS
): string {
  const facts = factsForLLMContext(results)
  if (facts.length === 0) return 'No additional facts found.'
  return facts
    .map((r, i) => {
      const id = r.metadata?.id ?? `fact-${i + 1}`
      return `${i + 1}. [${id}]\n${formatFactContentForLLM(r.content, maxContentChars)}`
    })
    .join('\n\n')
}
