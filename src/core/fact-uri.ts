/** Stored fact row ids use prefix `fact-` + hex; canonical URI is `fact://` + hex (no doubled "fact"). */
export function formatFactUri(id: string): string {
  if (id.startsWith('fact-')) {
    return `fact://${id.slice('fact-'.length)}`
  }
  return id
}
