/**
 * Deterministic sentence-like segments from markdown/plain text for fact ingest.
 * Not linguistic perfection — stable splits for pipeline + submit single-sentence checks.
 */

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '\n')
}

/** Split on sentence-ending punctuation followed by whitespace. */
function splitEnglishSentences(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  const parts = trimmed.split(/(?<=[.!?])\s+/).map(s => s.trim())
  return parts.filter(s => s.length > 0)
}

/**
 * Extract ordered segments: each markdown heading line becomes one segment (title only);
 * other lines are split into sentences.
 */
export function segmentMarkdownForFacts(markdown: string): string[] {
  const body = stripFencedCodeBlocks(markdown)
  const out: string[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^#{1,6}\s+/.test(line)) {
      const title = line.replace(/^#{1,6}\s+/, '').trim()
      if (title.length > 0) out.push(title)
      continue
    }
    out.push(...splitEnglishSentences(line))
  }
  return out.filter(s => s.replace(/\s+/g, ' ').trim().length >= 8)
}

/** For `kb submit`: user string must be a single sentence (one segment after trim). */
export function assertSingleSentenceForSubmit(text: string): string {
  const t = text.trim()
  if (!t) throw new Error('submit: empty fact text')
  const segs = segmentMarkdownForFacts(t)
  if (segs.length === 0) {
    if (t.length < 8) throw new Error('submit: fact text too short (min 8 characters)')
    return t
  }
  if (segs.length > 1) {
    throw new Error(
      'submit: provide exactly one sentence. Split multi-sentence facts into separate kb submit calls.'
    )
  }
  const only = segs[0]
  return only ?? t
}
