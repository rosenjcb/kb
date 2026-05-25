/** Full-fidelity fact payloads for LLM answer synthesis — no truncation or snippet extraction. */

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

export function formatFactContentForLLM(content: string | undefined): string {
  const text = (content ?? '').trim()
  return text || 'No content available.'
}

export function formatRetrievedFactsForLLM(
  results: RetrievedFactForLLM[] | undefined | null,
  options?: {
    heading?: (item: RetrievedFactForLLM, index: number) => string
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
    const heading =
      options?.heading?.(fact, index) ??
      (title && title !== id
        ? `Fact ${index + 1}: ${title} (id=${id})`
        : `Fact ${index + 1} (id=${id})`)
    sections.push(`${heading}\n${formatFactContentForLLM(fact.content)}`)
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

export function formatToolQueryFactsForLLM(results: RetrievedFactForLLM[]): string {
  const facts = factsForLLMContext(results)
  if (facts.length === 0) return 'No additional facts found.'
  return facts
    .map((r, i) => {
      const id = r.metadata?.id ?? `fact-${i + 1}`
      return `${i + 1}. [${id}]\n${formatFactContentForLLM(r.content)}`
    })
    .join('\n\n')
}

export function formatSessionPoolFactsForLLM(
  poolFacts: Array<{ id: string; text: string }>
): string {
  return poolFacts
    .map((f, i) => `${i + 1}. [${f.id}]\n${formatFactContentForLLM(f.text)}`)
    .join('\n\n')
}
