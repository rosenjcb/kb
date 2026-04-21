/**
 * Wire format for agent-orchestration metadata (intent loop, retrieval, routing).
 * One line per fact: "<wire_key> <value>". TUI routes these to dim meta rows; CLI prints them subdued.
 */

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

/** Primary assistant stream in TUI — not orchestration metadata. */
const NON_META_WIRE_PREFIXES = new Set(['assistant'])

export function isOrchestrationMetaLine(line: string): boolean {
  const t = line.trimStart()
  // Allow `key> value`, `key> `, or `key>` (TUI runner trimEnd() can strip the space after `>` on empty values)
  const m = /^([a-z][a-z0-9_]*)>\s*(.*)$/.exec(t)
  if (!m) return false
  return !NON_META_WIRE_PREFIXES.has(m[1])
}
