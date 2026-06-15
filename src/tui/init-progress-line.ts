/** Split a progress-sink line into an optional repo slug and the remainder. */
export function parseInitProgressLine(line: string): { repo?: string; body: string } {
  const sep = ' │ '
  const idx = line.indexOf(sep)
  if (idx === -1) return { body: line }
  const head = line.slice(0, idx)
  const body = line.slice(idx + sep.length)
  const repoMatch = head.match(/@\s+(\S+)$/)
  return { repo: repoMatch?.[1], body }
}
