/**
 * GraphEntityExtractor — LLM-based extraction of entities and relationships from text.
 *
 * Used by:
 *   - pass-graph cycle in kb init (full corpus extraction)
 *   - submit_fact handler (incremental extraction for a single fact)
 *   - kb invalidate (identifies doc_id to soft-delete)
 */

import type { LLMProvider } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import type {
  EntityType,
  GraphEntity,
  GraphRelationship,
  RelationshipType,
} from './kb-graph-writer'

export interface ExtractedGraph {
  entities: GraphEntity[]
  relationships: GraphRelationship[]
}

export interface GraphBatchProgress {
  docsProcessed: number
  totalDocs: number
  batchDocs: number
  batchEntities: number
  batchRelationships: number
  totalEntities: number
  totalRelationships: number
}

const VALID_ENTITY_TYPES = new Set<string>(['concept', 'system', 'tool', 'decision', 'person'])
const VALID_REL_TYPES = new Set<string>([
  'depends_on',
  'contradicts',
  'related_to',
  'replaces',
  'implements',
  'uses',
])

const EXTRACTION_SYSTEM_PROMPT = loadPrompt('graph-extraction.md')
const GRAPH_EXTRACT_MAX_TOKENS_INITIAL = parseEnvInt('KB_GRAPH_EXTRACT_MAX_TOKENS_INITIAL', 8192)
const GRAPH_EXTRACT_MAX_TOKENS_RETRY = parseEnvInt('KB_GRAPH_EXTRACT_MAX_TOKENS_RETRY', 16_384)

/**
 * Extract entities and relationships from a single text passage.
 * Returns empty arrays on LLM failure or malformed output.
 */
export async function extractGraph(
  text: string,
  provider: LLMProvider,
  docId?: string
): Promise<ExtractedGraph> {
  if (!text.trim()) return { entities: [], relationships: [] }

  const callModel = async (maxTokens: number): Promise<string> => {
    const response = await provider.call({
      messages: [
        {
          role: 'user',
          content: `Text to extract from:\n\n${text}`,
        },
      ],
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      maxTokens,
      temperature: 0,
      // Gemini 2.5 otherwise spends the output budget on "thinking" and returns no JSON.
      thinkingBudget: 0,
    })
    return response.text.trim()
  }

  let raw: string
  try {
    // Large init docs can exceed 2k output tokens of JSON; truncation yields empty parses.
    raw = await callModel(GRAPH_EXTRACT_MAX_TOKENS_INITIAL)
  } catch {
    return { entities: [], relationships: [] }
  }

  let parsed = parseExtractorOutput(raw, docId)
  if (
    parsed.entities.length === 0 &&
    parsed.relationships.length === 0 &&
    raw.includes('{') &&
    raw.length > 400
  ) {
    try {
      raw = await callModel(GRAPH_EXTRACT_MAX_TOKENS_RETRY)
      parsed = parseExtractorOutput(raw, docId)
    } catch {
      /* keep first parse result */
    }
  }

  return parsed
}

/**
 * Extract from multiple documents in batch. Each document is processed separately
 * so a single LLM error doesn't abort the whole corpus.
 */
const GRAPH_BATCH_CONCURRENCY = 5

export async function extractGraphBatch(
  docs: Array<{ id: string; text: string }>,
  provider: LLMProvider,
  options: {
    onProgress?: (progress: GraphBatchProgress) => void
  } = {}
): Promise<ExtractedGraph> {
  const allEntities: GraphEntity[] = []
  const allRelationships: GraphRelationship[] = []
  const seenEntityIds = new Set<string>()
  const seenRelIds = new Set<string>()

  const filtered = docs.filter(d => d.text.trim())
  const totalDocs = filtered.length

  // Process in parallel batches to avoid sequential LLM calls on large corpora
  for (let i = 0; i < filtered.length; i += GRAPH_BATCH_CONCURRENCY) {
    const batch = filtered.slice(i, i + GRAPH_BATCH_CONCURRENCY)
    const results = await Promise.all(batch.map(doc => extractGraph(doc.text, provider, doc.id)))
    let batchEntities = 0
    let batchRelationships = 0

    for (const result of results) {
      for (const e of result.entities) {
        if (!seenEntityIds.has(e.id)) {
          seenEntityIds.add(e.id)
          allEntities.push(e)
          batchEntities += 1
        }
      }
      for (const r of result.relationships) {
        const relId = `${r.fromId}__${r.type}__${r.toId}`
        if (!seenRelIds.has(relId)) {
          seenRelIds.add(relId)
          allRelationships.push(r)
          batchRelationships += 1
        }
      }
    }

    options.onProgress?.({
      docsProcessed: Math.min(i + batch.length, totalDocs),
      totalDocs,
      batchDocs: batch.length,
      batchEntities,
      batchRelationships,
      totalEntities: allEntities.length,
      totalRelationships: allRelationships.length,
    })
  }

  return { entities: allEntities, relationships: allRelationships }
}

/**
 * When models wrap JSON in prose, find the outermost `{ ... }` object by brace depth
 * (string-aware) so we can still parse valid extractor payloads.
 */
export function extractBalancedJsonObject(source: string): string | null {
  const start = source.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\' && inStr) {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** Exported for unit tests — parses raw LLM output into graph shapes. */
export function parseGraphExtractorJson(raw: string, docId?: string): ExtractedGraph {
  return parseExtractorOutput(raw, docId)
}

function parseExtractorOutput(raw: string, docId?: string): ExtractedGraph {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const slice = extractBalancedJsonObject(cleaned)
    if (!slice) return { entities: [], relationships: [] }
    try {
      parsed = JSON.parse(slice)
    } catch {
      return { entities: [], relationships: [] }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { entities: [], relationships: [] }
  }

  const raw2 = parsed as Record<string, unknown>
  const entities: GraphEntity[] = []
  const relationships: GraphRelationship[] = []

  if (Array.isArray(raw2.entities)) {
    for (const item of raw2.entities) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const id = typeof e.id === 'string' ? e.id.trim() : ''
      const name = typeof e.name === 'string' ? e.name.trim() : ''
      const type = typeof e.type === 'string' ? e.type.trim() : 'concept'
      if (!id || !name) continue
      entities.push({
        id,
        name,
        type: VALID_ENTITY_TYPES.has(type) ? (type as EntityType) : 'concept',
        docId,
      })
    }
  }

  const entityIds = new Set(entities.map(e => e.id))

  if (Array.isArray(raw2.relationships)) {
    for (const item of raw2.relationships) {
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const fromId = typeof r.fromId === 'string' ? r.fromId.trim() : ''
      const toId = typeof r.toId === 'string' ? r.toId.trim() : ''
      const type = typeof r.type === 'string' ? r.type.trim() : ''
      if (!fromId || !toId || !type) continue
      if (!entityIds.has(fromId) || !entityIds.has(toId)) continue
      if (!VALID_REL_TYPES.has(type)) continue
      relationships.push({
        fromId,
        toId,
        type: type as RelationshipType,
        docId,
        weight: 1.0,
      })
    }
  }

  return { entities, relationships }
}

export { EXTRACTION_SYSTEM_PROMPT }

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 256) return fallback
  return parsed
}
