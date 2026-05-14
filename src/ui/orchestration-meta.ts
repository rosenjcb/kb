/**
 * Wire format for agent-orchestration metadata (intent loop, retrieval, routing).
 * One line per fact: "<wire_key> <value>". TUI routes these to dim meta rows; CLI prints them subdued.
 *
 * All known wire keys are registered in WIRE_KEY. New tools/agents MUST add their key here
 * rather than using raw strings, so the output-tier model (src/core/TUI.md) is consistently enforced.
 */

/** Registry of all known orchestration wire keys. Use these instead of raw strings. */
export const WIRE_KEY = {
  // T1 metadata — retrieval and evidence provenance
  RETRIEVAL: 'retrieval',
  EVIDENCE: 'evidence',
  SOURCES: 'sources',
  MATCHES: 'matches',
  QUERY: 'query',
  INTENT: 'intent',
  ROUTING: 'routing',

  // T1 metadata — thinking/reasoning traces
  THINKING: 'thinking',

  // T3 content — primary assistant stream (excluded from isOrchestrationMetaLine)
  ASSISTANT: 'assistant',

  // Display helpers
  SEP: 'sep',
  SOURCE: 'source',
  INDEX: 'index',
} as const

export type WireKey = (typeof WIRE_KEY)[keyof typeof WIRE_KEY]

export function orchestrationWireKey(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
  return slug.length > 0 ? slug : 'meta'
}

export function formatOrchestrationMetaLine(label: string, value: string): string {
  return `${orchestrationWireKey(label)}> ${value}`
}

/** Primary assistant stream in TUI — not orchestration metadata (T3 content, not T1 metadata). */
const NON_META_WIRE_PREFIXES = new Set<string>([WIRE_KEY.ASSISTANT])

export function isOrchestrationMetaLine(line: string): boolean {
  const t = line.trimStart()
  // Allow `key> value`, `key> `, or `key>` (TUI runner trimEnd() can strip the space after `>` on empty values)
  const m = /^([a-z][a-z0-9_]*)>\s*(.*)$/.exec(t)
  if (!m) return false
  return !NON_META_WIRE_PREFIXES.has(m[1])
}
