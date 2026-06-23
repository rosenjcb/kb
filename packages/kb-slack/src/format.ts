/**
 * Pure text helpers for turning a Slack mention into a kb question and a kb-server
 * response into a Slack reply. No I/O — unit-testable.
 */
import type { QuerySource } from './kb.js'

/** Strip Slack `<@U…>` mention tokens (the `@kb` ping) and collapse whitespace. */
export function stripMention(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build a Slack reply from a `/v1/query` or `/v1/chat` response.
 * Expects `{ answer, results[] }`. Posts the synthesized answer plus up to three
 * source titles; falls back to a friendly miss when there is none.
 */
export function formatReply(result: { answer?: string | null; results?: QuerySource[] }): string {
  const answer = typeof result?.answer === 'string' ? result.answer.trim() : ''
  if (!answer) {
    return "I couldn't find anything in the knowledge base for that."
  }

  const sources = Array.isArray(result?.results) ? result.results : []
  const top = sources
    .map(s => s?.title || s?.filePath)
    .filter((s): s is string => Boolean(s))
    .slice(0, 3)

  if (top.length === 0) return answer
  const list = top.map(s => `• ${s}`).join('\n')
  return `${answer}\n\n*Sources*\n${list}`
}
