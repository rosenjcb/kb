/**
 * Deterministic sentence-like segments from markdown/plain text for fact ingest.
 * Not linguistic perfection — stable splits for pipeline + fact single-sentence checks.
 */

import { parseOkfDocument } from './okf'

export interface SegmentMarkdownForFactsOptions {
  minSegmentLength?: number
  /** Merge adjacent short prose segments until they reach this size. */
  mergeShortSegmentsBelow?: number
}

/** Extract fenced code block content as single collapsed segments (one per block). */
function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let match = re.exec(text)
  while (match !== null) {
    const content = (match[1] ?? '').replace(/\s+/g, ' ').trim()
    if (content.length >= 8) blocks.push(content)
    match = re.exec(text)
  }
  return blocks
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '\n')
}

/** Split on sentence-ending punctuation followed by whitespace. */
function splitEnglishSentences(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  const parts = trimmed.split(/(?<=[.!?])\s+/).map(s => s.trim())
  return parts.filter(s => s.length > 0)
}

function normalizedLength(segment: string): number {
  return segment.replace(/\s+/g, ' ').trim().length
}

function mergeShortSegments(
  segments: string[],
  minSegmentLength: number,
  mergeShortSegmentsBelow: number | undefined
): string[] {
  if (!mergeShortSegmentsBelow || mergeShortSegmentsBelow <= minSegmentLength) {
    return segments.filter(s => normalizedLength(s) >= minSegmentLength)
  }

  const merged: string[] = []
  const pending: string[] = []
  const flushPending = () => {
    const joined = pending.join(' ').replace(/\s+/g, ' ').trim()
    pending.length = 0
    if (joined.length >= minSegmentLength) merged.push(joined)
  }

  for (const segment of segments) {
    const normalized = segment.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    if (normalized.length >= mergeShortSegmentsBelow) {
      flushPending()
      merged.push(normalized)
      continue
    }
    pending.push(normalized)
    if (pending.join(' ').length >= mergeShortSegmentsBelow) flushPending()
  }
  flushPending()
  return merged
}

/**
 * Extract ordered segments: fenced code blocks become one segment each (preserving
 * CLI examples, config snippets, etc.); headings and prose sentences follow.
 *
 * Functional OKF support: a leading frontmatter block (OKF boilerplate) is stripped
 * before segmentation so the metadata never leaks in as raw `key: value` facts. The
 * body is then segmented exactly like plain markdown — OKF docs get no special
 * retrieval boost, kb just reads them cleanly.
 */
export function segmentMarkdownForFacts(
  markdown: string,
  options: SegmentMarkdownForFactsOptions = {}
): string[] {
  const minSegmentLength = options.minSegmentLength ?? 8
  const { body } = parseOkfDocument(markdown)

  const codeBlocks = extractFencedCodeBlocks(body)
  const stripped = stripFencedCodeBlocks(body)
  const prose: string[] = []
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^#{1,6}\s+/.test(line)) {
      const title = line.replace(/^#{1,6}\s+/, '').trim()
      if (title.length > 0) prose.push(title)
      continue
    }
    prose.push(...splitEnglishSentences(line))
  }
  return [
    ...codeBlocks.filter(s => normalizedLength(s) >= minSegmentLength),
    ...mergeShortSegments(prose, minSegmentLength, options.mergeShortSegmentsBelow),
  ]
}

/** Validate that a fact string is a single sentence (one segment after trim). */
export function assertSingleSentenceFact(text: string): string {
  const t = text.trim()
  if (!t) throw new Error('fact text is empty')
  const segs = segmentMarkdownForFacts(t)
  if (segs.length === 0) {
    if (t.length < 8) throw new Error('fact text too short (min 8 characters)')
    return t
  }
  if (segs.length > 1) {
    throw new Error('provide exactly one sentence per fact')
  }
  const only = segs[0]
  return only ?? t
}
