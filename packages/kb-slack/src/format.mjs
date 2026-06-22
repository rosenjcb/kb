/**
 * Pure text helpers for turning a Slack mention into a kb question and a kb-server
 * `/v1/query` response into a Slack reply. No I/O — unit-testable.
 */

/** Strip Slack `<@U…>` mention tokens (the `@kb` ping) and collapse whitespace. */
export function stripMention(text) {
  if (!text) return ''
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build the Slack reply from a `/v1/query` response body
 * (`{ status, answer, results[], … }`, see src/server/serialize.ts). Posts the synthesized
 * answer plus up to three source titles; falls back to a friendly miss when there is none.
 */
export function formatReply(result) {
  const answer = typeof result?.answer === 'string' ? result.answer.trim() : ''
  if (!answer) {
    return "I couldn't find anything in the knowledge base for that."
  }

  const sources = Array.isArray(result?.results) ? result.results : []
  const top = sources
    .map(source => source?.title || source?.filePath)
    .filter(Boolean)
    .slice(0, 3)

  if (top.length === 0) return answer
  const list = top.map(source => `• ${source}`).join('\n')
  return `${answer}\n\n*Sources*\n${list}`
}
