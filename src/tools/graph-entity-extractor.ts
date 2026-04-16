/**
 * GraphEntityExtractor — LLM-based extraction of entities and relationships from text.
 *
 * Used by:
 *   - pass-graph cycle in kb init (full corpus extraction)
 *   - submit_fact handler (incremental extraction for a single fact)
 *   - kb invalidate (identifies doc_id to soft-delete)
 */

import type { LLMProvider } from '../core/types'
import type { GraphEntity, GraphRelationship, EntityType, RelationshipType } from './duck-graph-writer'

export interface ExtractedGraph {
  entities: GraphEntity[]
  relationships: GraphRelationship[]
}

const VALID_ENTITY_TYPES = new Set<string>(['concept', 'system', 'tool', 'decision', 'person'])
const VALID_REL_TYPES = new Set<string>(['depends_on', 'contradicts', 'related_to', 'replaces', 'implements', 'uses'])

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge graph extractor. Given a passage of text, extract:
1. Entities: named concepts, systems, tools, decisions, or people.
2. Relationships: directed edges between those entities.

Output ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "entities": [
    { "id": "slug-form-id", "name": "Human Readable Name", "type": "concept|system|tool|decision|person" }
  ],
  "relationships": [
    { "fromId": "entity-id", "toId": "entity-id", "type": "depends_on|contradicts|related_to|replaces|implements|uses" }
  ]
}

Rules:
- Entity ids must be lowercase, hyphen-separated, max 50 chars (e.g. "duckdb", "kb-init", "openai-api")
- Only extract entities explicitly mentioned or strongly implied
- Only extract relationships where both endpoints appear as entities in your output
- Omit entities or relationships you are uncertain about
- Return empty arrays if the text contains no extractable graph elements`

/**
 * Extract entities and relationships from a single text passage.
 * Returns empty arrays on LLM failure or malformed output.
 */
export async function extractGraph(
  text: string,
  provider: LLMProvider,
  docId?: string,
): Promise<ExtractedGraph> {
  if (!text.trim()) return { entities: [], relationships: [] }

  let raw: string
  try {
    const response = await provider.call({
      messages: [
        {
          role: 'user',
          content: `${EXTRACTION_SYSTEM_PROMPT}\n\nText to extract from:\n\n${text}`,
        },
      ],
      maxTokens: 2048,
      temperature: 0,
    })
    raw = response.text.trim()
  } catch {
    return { entities: [], relationships: [] }
  }

  return parseExtractorOutput(raw, docId)
}

/**
 * Extract from multiple documents in batch. Each document is processed separately
 * so a single LLM error doesn't abort the whole corpus.
 */
export async function extractGraphBatch(
  docs: Array<{ id: string; text: string }>,
  provider: LLMProvider,
): Promise<ExtractedGraph> {
  const allEntities: GraphEntity[] = []
  const allRelationships: GraphRelationship[] = []
  const seenEntityIds = new Set<string>()
  const seenRelIds = new Set<string>()

  for (const doc of docs) {
    if (!doc.text.trim()) continue

    const result = await extractGraph(doc.text, provider, doc.id)

    for (const e of result.entities) {
      if (!seenEntityIds.has(e.id)) {
        seenEntityIds.add(e.id)
        allEntities.push(e)
      }
    }

    for (const r of result.relationships) {
      const relId = `${r.fromId}__${r.type}__${r.toId}`
      if (!seenRelIds.has(relId)) {
        seenRelIds.add(relId)
        allRelationships.push(r)
      }
    }
  }

  return { entities: allEntities, relationships: allRelationships }
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
    return { entities: [], relationships: [] }
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
