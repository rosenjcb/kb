import type { DocGenerateSession } from './doc-generate-session'

const TITLE_TRY_KEYS = [
  'documentTitle',
  'oneLineThesis',
  'subject',
  'goal',
  'choice',
  'trigger',
  'title',
  'context',
] as const

const MAX_TITLE_CHARS = 72
const MAX_TITLE_WORDS = 10

/**
 * Normalize user or LLM-derived text into a short KB document title (noun-style, not a long statement).
 */
export function squeezeKbDocumentTitle(raw: string): string {
  let s = raw.trim().split('\n')[0]?.trim() ?? ''
  if (!s) return ''
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/[.?!]+$/u, '')
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length > MAX_TITLE_WORDS) {
    s = words.slice(0, MAX_TITLE_WORDS).join(' ')
  }
  if (s.length > MAX_TITLE_CHARS) {
    s = s.slice(0, MAX_TITLE_CHARS)
    const lastSpace = s.lastIndexOf(' ')
    if (lastSpace > 32) {
      s = s.slice(0, lastSpace)
    }
    s = s.trimEnd()
  }
  return s.trim()
}

export function deriveDocumentTitle(session: DocGenerateSession): string {
  for (const key of TITLE_TRY_KEYS) {
    const slot = session.answers.find(a => a.key === key)
    const v = slot?.answer?.trim()
    if (v) {
      const squeezed = squeezeKbDocumentTitle(v)
      if (squeezed) return squeezed
    }
  }
  for (const slot of session.answers) {
    if (slot.skipped) continue
    const v = slot.answer?.trim()
    if (v) {
      const squeezed = squeezeKbDocumentTitle(v)
      if (squeezed) return squeezed
    }
  }
  const line = session.prompt.split('\n')[0].trim()
  return squeezeKbDocumentTitle(line) || 'Generated document'
}
