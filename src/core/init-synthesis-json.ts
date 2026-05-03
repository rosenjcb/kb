/**
 * Init pass1 synthesis: parse model output into one KB document shape, plus JSON Schemas for
 * providers that support native structured JSON (OpenAI json_schema, Gemini responseSchema).
 */
import { DOC_TYPES, isDocType } from './doc-taxonomy'
import type { WriteDocumentInput } from '../tools/document-writer'
import { extractBalancedJsonObject } from '../tools/graph-entity-extractor'

/** OpenAI Chat Completions `response_format.json_schema` (strict) — all properties required. */
export const INIT_SYNTHESIS_OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Concise Cap Every Word title, no file extensions' },
    type: {
      type: 'string',
      enum: [...DOC_TYPES],
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short topical tags',
    },
    content: {
      type: 'string',
      description: 'Markdown body for the KB document',
    },
  },
  required: ['title', 'type', 'tags', 'content'],
}

/** Gemini `generationConfig.responseSchema` (Schema proto JSON style). */
export const INIT_SYNTHESIS_GEMINI_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    // Allowed literals are enforced in prompt + parseInitSynthesisObject; Gemini enum Schema
    // varies by API version — keep STRING for broad compatibility.
    type: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    content: { type: 'STRING' },
  },
  required: ['title', 'type', 'tags', 'content'],
}

export interface ParsedInitSynthesisDoc {
  title: string
  content: string
  type?: WriteDocumentInput['type']
  tags?: string[]
}

/**
 * Strip optional markdown fences without truncating at the first ``` inside JSON `content`
 * (non-greedy `[\s\S]*?` between fences is unsafe when the body contains code blocks).
 */
export function stripSynthesisJsonWrapper(text: string): string {
  const raw = text.trim()
  const lines = raw.split('\n')
  if (lines.length === 0) return raw

  let openIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^```(?:json)?\s*$/i.test(lines[i].trim())) {
      openIdx = i
      break
    }
  }
  if (openIdx === -1) return raw

  let closeIdx = -1
  for (let j = lines.length - 1; j > openIdx; j--) {
    if (lines[j].trim() === '```') {
      closeIdx = j
      break
    }
  }
  if (closeIdx === -1)
    return lines
      .slice(openIdx + 1)
      .join('\n')
      .trim()
  return lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .trim()
}

export function parseInitSynthesisObject(text: string): ParsedInitSynthesisDoc | null {
  const trimmed = stripSynthesisJsonWrapper(text)
  const jsonSlice = extractBalancedJsonObject(trimmed) ?? trimmed.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonSlice) return null
  try {
    const parsed = JSON.parse(jsonSlice) as Record<string, unknown>
    if (typeof parsed.title !== 'string' || typeof parsed.content !== 'string') return null
    const doc: ParsedInitSynthesisDoc = {
      title: parsed.title.trim(),
      content: parsed.content,
    }
    if (isDocType(parsed.type)) {
      doc.type = parsed.type
    }
    if (Array.isArray(parsed.tags)) {
      doc.tags = parsed.tags.map(String)
    }
    return doc
  } catch {
    return null
  }
}
