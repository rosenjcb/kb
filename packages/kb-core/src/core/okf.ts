import yaml from 'js-yaml'

/**
 * Open Knowledge Format (OKF v0.1) awareness.
 *
 * OKF is the LLM-wiki standard kb encourages for companion docs (see the
 * `spec-md` skill): a markdown file with a leading YAML frontmatter
 * block whose only required field is `type`. kb gives OKF **functional support
 * only** — it recognizes the format and strips the frontmatter boilerplate so
 * the metadata block is not indexed as raw `key: value` facts, then ingests the
 * body exactly like plain markdown. No special retrieval boost.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */

/** Leading YAML frontmatter block: `---\n ... \n---` (tolerates a BOM and CRLF). */
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface OkfFrontmatter {
  /** Required by OKF — the concept kind (e.g. "Subsystem", "Playbook", "API Endpoint"). */
  type: string
  title?: string
  description?: string
  resource?: string
  tags?: string[]
  timestamp?: string
  [key: string]: unknown
}

export interface ParsedDocument {
  /** True when the doc has frontmatter carrying a non-empty `type` (OKF conformance). */
  isOkf: boolean
  /** Parsed OKF frontmatter when the doc conforms, else null. */
  frontmatter: OkfFrontmatter | null
  /** Document body with any leading frontmatter block removed. */
  body: string
}

function normalizeTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.map(v => String(v).trim()).filter(Boolean)
    return tags.length ? tags : undefined
  }
  if (typeof value === 'string') {
    const tags = value
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
    return tags.length ? tags : undefined
  }
  return undefined
}

/**
 * Split a markdown doc into frontmatter (if any) and body, flagging OKF conformance.
 *
 * Never throws. To avoid eating real content from a leading thematic break, the
 * frontmatter block is only stripped when it parses as a YAML mapping; anything
 * else (parse error, scalar, list) is returned untouched as plain markdown.
 * Matches OKF's rule that consumers tolerate incomplete bundles gracefully.
 */
export function parseOkfDocument(markdown: string): ParsedDocument {
  const match = FRONTMATTER_RE.exec(markdown)
  if (!match) return { isOkf: false, frontmatter: null, body: markdown }

  let parsed: unknown
  try {
    parsed = yaml.load(match[1] ?? '')
  } catch {
    // Unparseable — likely a horizontal rule, not frontmatter. Keep the doc intact.
    return { isOkf: false, frontmatter: null, body: markdown }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { isOkf: false, frontmatter: null, body: markdown }
  }

  // It is a real frontmatter mapping — strip it from the body either way.
  const body = markdown.slice(match[0].length)
  const record = parsed as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!type) return { isOkf: false, frontmatter: null, body }

  const frontmatter: OkfFrontmatter = { ...record, type }
  if (typeof record.title === 'string') frontmatter.title = record.title.trim()
  if (typeof record.description === 'string') frontmatter.description = record.description.trim()
  if (typeof record.resource === 'string') frontmatter.resource = record.resource.trim()
  if (typeof record.timestamp === 'string') frontmatter.timestamp = record.timestamp.trim()
  const tags = normalizeTags(record.tags)
  if (tags) frontmatter.tags = tags

  return { isOkf: true, frontmatter, body }
}

/** True when a markdown doc conforms to OKF (frontmatter with a non-empty `type`). */
export function isOkfDocument(markdown: string): boolean {
  return parseOkfDocument(markdown).isOkf
}
