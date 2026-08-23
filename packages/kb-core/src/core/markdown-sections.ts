/**
 * Split a markdown document into sections for full-text indexing.
 *
 * A whole file is the wrong retrieval unit. A long, topically-broad document has a structurally
 * higher chance of containing an isolated hit on *every* distinct term in a multi-term query —
 * scattered across unrelated sections — than the small file that actually answers it does. BM25's
 * length normalization does not address this, because the problem is not that the long document is
 * scored too generously for its length; it is that breadth of vocabulary is being counted as
 * relevance. Shrinking the indexed unit to a section removes the structural advantage instead of
 * discounting it after the fact.
 *
 * Deliberately has no tunable weight. The only knob is where a section ends, which markdown already
 * tells us.
 */

/** Below this, a section is too small to stand alone and is merged forward into the next one. */
const MIN_SECTION_CHARS = 200
/**
 * Target ceiling for a section. Split happens on paragraph boundaries, so a single enormous
 * paragraph still exceeds it — a target, not a guarantee.
 */
const MAX_SECTION_CHARS = 4000

export interface MarkdownSection {
  /** Heading trail, e.g. "Configuration > Environment variables". Empty for a preamble. */
  heading: string
  text: string
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** Split on ``` fences so a `#` comment inside a code block is not read as a heading. */
function headingLineIndices(lines: string[]): Map<number, { depth: number; title: string }> {
  const out = new Map<number, { depth: number; title: string }>()
  let inFence = false
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fence = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fence) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = ATX_HEADING.exec(line)
    if (m) out.set(i, { depth: m[1].length, title: m[2].trim() })
  }
  return out
}

function hardSplit(section: MarkdownSection): MarkdownSection[] {
  if (section.text.length <= MAX_SECTION_CHARS) return [section]
  const out: MarkdownSection[] = []
  const paragraphs = section.text.split(/\n{2,}/)
  let buf: string[] = []
  let size = 0
  const flush = () => {
    if (buf.length === 0) return
    out.push({ heading: section.heading, text: buf.join('\n\n') })
    buf = []
    size = 0
  }
  for (const p of paragraphs) {
    if (size > 0 && size + p.length > MAX_SECTION_CHARS) flush()
    buf.push(p)
    size += p.length + 2
  }
  flush()
  return out.length > 0 ? out : [section]
}

/**
 * Sections of a markdown body, in document order.
 *
 * Always returns at least one section, so a document without headings still indexes as itself
 * rather than disappearing.
 */
export function splitMarkdownSections(body: string): MarkdownSection[] {
  const text = body ?? ''
  if (!text.trim()) return []
  const lines = text.split('\n')
  const headings = headingLineIndices(lines)

  const raw: MarkdownSection[] = []
  // Heading trail by depth, so a nested section carries its parents' titles into the indexed text.
  const trail: string[] = []
  let buf: string[] = []
  let heading = ''

  const push = () => {
    const t = buf.join('\n').trim()
    if (t) raw.push({ heading, text: t })
    buf = []
  }

  for (let i = 0; i < lines.length; i++) {
    const h = headings.get(i)
    if (h) {
      push()
      trail.length = Math.max(0, h.depth - 1)
      trail[h.depth - 1] = h.title
      heading = trail.filter(Boolean).join(' > ')
      buf.push(lines[i])
      continue
    }
    buf.push(lines[i])
  }
  push()

  // Merge runs that are too short to stand alone — a bare heading followed by one line is not a
  // useful retrieval unit, and splitting it only fragments the signal.
  const merged: MarkdownSection[] = []
  for (const section of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.text.length < MIN_SECTION_CHARS) {
      prev.text = `${prev.text}\n\n${section.text}`
      // Keep the shallower heading as the label for the combined block.
      continue
    }
    merged.push({ ...section })
  }

  return merged.flatMap(hardSplit)
}
