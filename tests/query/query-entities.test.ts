import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LEAN_ENTITY_CAP,
  assembleQueryEntities,
  capQueryEntities,
  formatKnownEntitiesBlock,
} from '@kb/core/query/query-entities.js'
import type { ScopeVerdict } from '@kb/core/query/scope-inference.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-query-entities-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function seedRegistry(): EntityRegistry {
  const registry = new EntityRegistry(dbPath)
  const apiId = registry.upsertEntity({
    kind: 'api',
    canonicalName: '/v1/query',
    gloss: 'one-shot query',
    sourceKind: 'harvest',
  })
  const svcId = registry.upsertEntity({
    kind: 'service',
    canonicalName: 'kb-server',
    sourceKind: 'harvest',
  })
  registry.upsertEntity({
    kind: 'repo',
    canonicalName: 'rosenjcb/kb',
    sourceKind: 'harvest',
  })
  registry.linkFact('fact-query', apiId, 'subject')
  registry.linkFact('fact-server', svcId, 'mention')
  return registry
}

describe('assembleQueryEntities', () => {
  it('[TC-ENT5] projects confident scope landings first and skips repo kind', () => {
    const registry = seedRegistry()
    const scope: ScopeVerdict = {
      unresolved: false,
      excludedFactIds: [],
      method: 'alias',
      candidates: [
        {
          entity: registry.findEntityByName('/v1/query')[0],
          label: 'very_confident',
        },
        {
          entity: registry.findEntityByName('rosenjcb/kb')[0],
          label: 'confident',
        },
      ],
    }
    registry.close()
    const entities = assembleQueryEntities({ dbPath, scope, results: [] })
    expect(entities.map(e => `${e.role}:${e.kind}:${e.name}`)).toEqual(['scope:api:/v1/query'])
  })

  it('[TC-ENT6] adds cited hits from entity_links and name matches after retrieval', () => {
    const registry = seedRegistry()
    registry.close()
    const entities = assembleQueryEntities({
      dbPath,
      results: [
        {
          metadata: { id: 'fact-server', title: 'server', sourcePath: 'src/http-server.ts' },
          content: 'POST /v1/query on kb-server',
        },
      ],
    })
    const names = entities.map(e => `${e.role}:${e.kind}:${e.name}`)
    expect(names).toContain('cited:service:kb-server')
    expect(names).toContain('cited:api:/v1/query')
  })

  it('[TC-ENT7] formatKnownEntitiesBlock is compact and capQueryEntities trims lean lists', () => {
    seedRegistry().close()
    const entities = assembleQueryEntities({
      dbPath,
      results: [
        {
          metadata: { id: 'fact-query', title: 'q', sourcePath: 'src/a.ts' },
          content: '/v1/query',
        },
      ],
    })
    expect(entities.length).toBeGreaterThan(0)
    expect(formatKnownEntitiesBlock(entities)).toMatch(/^Known entities: /)
    expect(capQueryEntities(entities, LEAN_ENTITY_CAP).length).toBeLessThanOrEqual(LEAN_ENTITY_CAP)
    expect(capQueryEntities([], 8)).toEqual([])
  })
})
