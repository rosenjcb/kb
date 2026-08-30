/**
 * Outbound query-entity projection — the same EntityKind landings that already
 * drove inquiry lanes, plus registry hits that intersect retrieved evidence.
 *
 * This is not a second expansion pass. `role: 'scope'` rows are the stage-0
 * landings; `role: 'cited'` rows are found after retrieval and are too late
 * for this turn's lanes.
 */

import { type EntityKind, EntityRegistry, type EntityRow } from '../tools/entity-registry.js'
import type { ReadDocumentsResultItem } from './intent-cli.js'
import type { ScopeVerdict } from './scope-inference.js'

export type QueryEntityRole = 'scope' | 'cited'

export interface QueryEntity {
  kind: EntityKind
  /** Canonical name — for routes this is the path (`/v1/query`). */
  name: string
  gloss?: string
  role: QueryEntityRole
}

export const LEAN_ENTITY_CAP = 8
export const VERBOSE_ENTITY_CAP = 20

const HTTP_PATH_RE = /\/[A-Za-z0-9_{}:.*\-]+(?:\/[A-Za-z0-9_{}:.*\-]+)*/g
const MAX_FACT_IDS = 100

export function toQueryEntity(row: EntityRow, role: QueryEntityRole): QueryEntity {
  return {
    kind: row.kind,
    name: row.canonicalName,
    ...(row.gloss ? { gloss: row.gloss } : {}),
    role,
  }
}

export function capQueryEntities(entities: QueryEntity[] | undefined, cap: number): QueryEntity[] {
  if (!entities || entities.length === 0) return []
  return entities.slice(0, cap)
}

export function formatKnownEntitiesBlock(entities: QueryEntity[]): string {
  if (entities.length === 0) return ''
  return `Known entities: ${entities.map(e => `${e.kind} ${e.name}`).join(' · ')}`
}

export function formatEntitiesLine(entities: QueryEntity[]): string {
  return entities.map(e => `${e.kind} ${e.name}`).join(' · ')
}

/**
 * Assemble the outbound entity list. Scope landings first, then cited hits.
 * Best-effort: an unreadable registry returns only the in-memory scope rows.
 */
export function assembleQueryEntities(input: {
  dbPath: string
  scope?: ScopeVerdict
  results?: ReadDocumentsResultItem[]
  cap?: number
}): QueryEntity[] {
  const cap = input.cap ?? VERBOSE_ENTITY_CAP
  const byKey = new Map<string, QueryEntity>()

  const add = (row: EntityRow, role: QueryEntityRole) => {
    if (row.kind === 'repo') return
    const key = `${row.kind}\0${row.canonicalName}`
    const existing = byKey.get(key)
    if (existing) {
      if (existing.role === 'cited' && role === 'scope') existing.role = 'scope'
      return
    }
    byKey.set(key, toQueryEntity(row, role))
  }

  const scopeRows =
    input.scope?.candidates
      .filter(c => c.label === 'very_confident' || c.label === 'confident')
      .map(c => c.entity) ?? []
  for (const row of scopeRows) add(row, 'scope')

  let registry: EntityRegistry | undefined
  try {
    registry = new EntityRegistry(input.dbPath, { readOnly: true })
    if (registry.entityCount() === 0) {
      return [...byKey.values()].slice(0, cap)
    }

    const results = input.results ?? []
    const factIds = results
      .map(r => r.metadata?.id?.trim())
      .filter((id): id is string => Boolean(id))
      .slice(0, MAX_FACT_IDS)
    for (const row of registry.entitiesForFactIds(factIds)) add(row, 'cited')

    const candidates = collectCiteCandidates(results)
    for (const name of candidates) {
      for (const row of registry.findEntityByName(name)) add(row, 'cited')
    }
  } catch {
    // Registry unreadable — still return scope landings we already have.
  } finally {
    registry?.close()
  }

  const ordered = [
    ...[...byKey.values()].filter(e => e.role === 'scope'),
    ...[...byKey.values()].filter(e => e.role === 'cited'),
  ]
  return ordered.slice(0, cap)
}

function collectCiteCandidates(results: ReadDocumentsResultItem[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string | undefined) => {
    const value = raw?.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }

  for (const item of results) {
    push(item.metadata?.symbol)
    const location = item.metadata?.sourcePath ?? item.metadata?.filePath
    if (location) {
      const base = location.split('/').pop()
      if (base) push(base.replace(/\.[^.]+$/, ''))
    }
    const haystack = [item.content, location].filter(Boolean).join('\n')
    for (const match of haystack.matchAll(HTTP_PATH_RE)) {
      const path = match[0]
      if (path.length > 1) push(path)
    }
  }
  return out
}
