/**
 * `entity-index` scan cycle: deterministic entity harvest + fact↔entity linking
 * (NOMENCLATURE_INDEX_PLAN.md §4). Runs per repo after `document-facts`, so both
 * code facts and doc facts exist when links are written. Best-effort by design —
 * a failed harvest must never fail `kb init` / `kb scan`.
 *
 * Steps:
 *  1. Harvest entity candidates from manifest-class files (ecosystem-harvesters).
 *  2. Upsert entities + aliases into the registry (repo itself becomes an entity).
 *  3. Link facts whose subject/object normalizes to a known alias — exact match
 *     only; the un-harvested world stays unlinked and therefore unprunable.
 *  4. Deterministic collision screen → `distinct_from` edges with contrastive glosses.
 */

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEnvFalse } from '../config/env-boolean.js'
import { harvestRepoEntities } from '../tools/ecosystem-harvesters.js'
import { EntityRegistry, normalizeEntityName } from '../tools/entity-registry.js'

export interface EntityIndexInput {
  baseDir: string
  scanDir: string
  /** Repo slug — becomes a `repo` entity and the `git_repo` on harvested entities. */
  gitRepo?: string
}

export interface EntityIndexResult {
  entitiesUpserted: number
  factsLinked: number
  collisions: number
}

/** Kill switch: KB_ENTITY_INDEX=false skips the harvest entirely. */
export function isEntityIndexEnabled(): boolean {
  return !isEnvFalse(process.env.KB_ENTITY_INDEX)
}

export async function runEntityIndexCycle(input: EntityIndexInput): Promise<EntityIndexResult> {
  if (!isEntityIndexEnabled()) {
    return { entitiesUpserted: 0, factsLinked: 0, collisions: 0 }
  }
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const registry = new EntityRegistry(dbPath)
  const result: EntityIndexResult = { entitiesUpserted: 0, factsLinked: 0, collisions: 0 }

  try {
    // The repo is itself an entity — repo-level scoping and entity-level scoping
    // share one vocabulary.
    if (input.gitRepo) {
      registry.upsertEntity({
        kind: 'repo',
        canonicalName: input.gitRepo,
        gitRepo: input.gitRepo,
        sourceKind: 'manifest',
      })
      result.entitiesUpserted++
    }

    const harvest = await harvestRepoEntities(input.scanDir)
    const idByName = new Map<string, string>()
    for (const candidate of harvest.candidates) {
      const id = registry.upsertEntity({
        kind: candidate.kind,
        canonicalName: candidate.canonicalName,
        ...(candidate.gloss ? { gloss: candidate.gloss } : {}),
        ...(input.gitRepo ? { gitRepo: input.gitRepo } : {}),
        sourceKind: candidate.sourceKind,
        contentHash: candidate.contentHash,
        confidence: candidate.confidence,
      })
      idByName.set(normalizeEntityName(candidate.canonicalName), id)
      for (const alias of candidate.aliases) {
        registry.addAlias(id, alias, candidate.sourceKind, candidate.confidence)
      }
      result.entitiesUpserted++
    }
    for (const edge of harvest.edges) {
      const from = idByName.get(normalizeEntityName(edge.fromName))
      const to = idByName.get(normalizeEntityName(edge.toName))
      if (from && to) registry.addEdge(from, to, edge.edgeType)
    }

    result.factsLinked = linkFactsToEntities(dbPath, registry)
    result.collisions = registry.detectCollisions()
  } finally {
    registry.close()
  }
  return result
}

/**
 * Exact-match linking: a fact links to an entity only when its subject or object
 * normalizes to one of the entity's aliases. Longest-alias precedence is implicit
 * because the whole string must match — "internal services" as a subject can only
 * equal the surface's alias, never the service's.
 */
function linkFactsToEntities(dbPath: string, registry: EntityRegistry): number {
  const aliasToEntities = new Map<string, string[]>()
  for (const entity of registry.listEntities()) {
    for (const alias of registry.listAliases(entity.id)) {
      const existing = aliasToEntities.get(alias.normalized)
      if (existing) {
        if (!existing.includes(entity.id)) existing.push(entity.id)
      } else {
        aliasToEntities.set(alias.normalized, [entity.id])
      }
    }
  }
  if (aliasToEntities.size === 0) return 0

  const db = new DatabaseSync(dbPath, { readOnly: true })
  let linked = 0
  try {
    const rows = db
      .prepare(
        `SELECT id, subject, object FROM facts
         WHERE tombstoned_at IS NULL AND (subject != '' OR object != '')`
      )
      .all() as Array<{ id: string; subject: string; object: string }>
    for (const row of rows) {
      for (const [value, role] of [
        [row.subject, 'subject'],
        [row.object, 'object'],
      ] as const) {
        if (!value) continue
        const entityIds = aliasToEntities.get(normalizeEntityName(value))
        if (!entityIds) continue
        for (const entityId of entityIds) {
          registry.linkFact(row.id, entityId, role)
          linked++
        }
      }
    }
  } finally {
    db.close()
  }
  return linked
}
