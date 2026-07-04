export type FeedbackKind = 'gap' | 'style'

const GAP_RE =
  /\b(missing|doesn't mention|add|include|forgot|more (about|detail|on)|also needs|what about|explain|elaborate|lacks|no mention|cover|expand)\b/i
const STYLE_RE =
  /\b(too (long|short|verbose|wordy)|tone|concise|reorder|reorganize|restructure|format|heading|shorter|longer|rewrite|flow|rename)\b/i

/**
 * Heuristic classifier for doc-generate rejection feedback.
 * 'gap'   → user wants content that requires more/different facts
 * 'style' → user wants cosmetic or structural changes to existing content
 * Defaults to 'gap' on tie — safer: attempts deeper retrieval rather than skipping it.
 */
export function classifyFeedback(feedback: string): FeedbackKind {
  const gapHits = (feedback.match(GAP_RE) ?? []).length
  const styleHits = (feedback.match(STYLE_RE) ?? []).length
  return styleHits > gapHits ? 'style' : 'gap'
}
