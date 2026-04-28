import { formatFactUri } from './fact-uri'
import type { SupportingFact } from './doc-supporting-facts'

const REFERENCES_HEADING = '## References'

/**
 * Render a `## References` footer enumerating supporting facts.
 *
 * Returns the empty string when there are no facts so callers can append
 * unconditionally without producing an orphan heading.
 *
 * Format is intentionally mechanical and stable so a future swap to a
 * separate fact-glossary doc only changes this renderer.
 */
export function renderReferencesFooter(facts: readonly SupportingFact[]): string {
  if (!facts.length) return ''
  const lines = [REFERENCES_HEADING, '']
  for (const fact of facts) {
    lines.push(`- ${fact.factText} — \`${formatFactUri(fact.id)}\``)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Append a References footer to drafted markdown, separating with a blank line.
 */
export function appendReferencesFooter(
  body: string,
  facts: readonly SupportingFact[]
): string {
  const footer = renderReferencesFooter(facts)
  if (!footer) return ensureTrailingNewline(body)
  const trimmed = body.replace(/\s+$/, '')
  return `${trimmed}\n\n${footer}`
}

function ensureTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`
}
