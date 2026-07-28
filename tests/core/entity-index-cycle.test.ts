import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runEntityIndexCycle } from '@kb/core/core/entity-index-cycle.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let scanDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-cycle-base-'))
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-cycle-scan-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
  await rm(scanDir, { recursive: true, force: true })
  process.env.KB_ENTITY_INDEX = undefined
})

/** Seed the #167 scenario: a service `internal` and a surface `Internal Services`. */
async function seedCollisionRepo(): Promise<{ serviceFact: string; surfaceFact: string; otherFact: string }> {
  await writeFile(
    path.join(scanDir, 'docker-compose.yml'),
    ['services:', '  internal:', '    image: acme/internal'].join('\n')
  )
  await writeFile(
    path.join(scanDir, 'catalog-info.yaml'),
    ['kind: Component', 'metadata:', '  name: Internal Services'].join('\n')
  )

  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    const serviceFact = indexer.upsertFact({
      factText: 'The internal service validates payment auth tokens.',
      triplet: { subject: 'internal', predicate: 'validates', object: 'payment auth tokens' },
      sourceKind: 'import_doc',
      sourceRef: 'payments-core/README.md#s1',
      gitRepo: 'payments-core',
    }).id
    const surfaceFact = indexer.upsertFact({
      factText: 'Internal Services shows operational dashboards.',
      triplet: { subject: 'Internal Services', predicate: 'shows', object: 'operational dashboards' },
      sourceKind: 'import_doc',
      sourceRef: 'payments-core/docs/ui.md#s1',
      gitRepo: 'payments-core',
    }).id
    // A fact about something the harvest knows nothing about — must stay unlinked.
    const otherFact = indexer.upsertFact({
      factText: 'The billing cron reconciles ledger entries nightly.',
      triplet: { subject: 'billing cron', predicate: 'reconciles', object: 'ledger entries' },
      sourceKind: 'import_doc',
      sourceRef: 'payments-core/docs/billing.md#s1',
      gitRepo: 'payments-core',
    }).id
    return { serviceFact, surfaceFact, otherFact }
  } finally {
    indexer.close()
  }
}

describe('runEntityIndexCycle', () => {
  it('harvests manifest entities, links facts by exact subject/object, and records collisions', async () => {
    const { serviceFact, surfaceFact, otherFact } = await seedCollisionRepo()

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
    // repo entity + compose service + backstage component
    expect(stats.entitiesUpserted).toBe(3)
    expect(stats.factsLinked).toBeGreaterThanOrEqual(2)
    expect(stats.collisions).toBeGreaterThanOrEqual(1)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const service = registry.findEntityByName('internal').find(e => e.kind === 'service')
      const surface = registry.findEntityByName('Internal Services')[0]
      expect(service).toBeDefined()
      expect(surface).toBeDefined()
      if (!service || !surface) return

      // Facts partition by entity — each side owns its own fact.
      expect(registry.linkedFactIds([service.id])).toContain(serviceFact)
      expect(registry.linkedFactIds([surface.id])).toContain(surfaceFact)
      // The un-harvested world stays unlinked.
      expect(registry.linkedFactIds([service.id, surface.id])).not.toContain(otherFact)

      // The collision is recorded with a contrastive gloss for a future consumer.
      const collisions = registry.distinctFromSiblings(service.id)
      expect(collisions).toHaveLength(1)
      expect(collisions[0]?.gloss).toContain('different things')
    } finally {
      registry.close()
    }
  })

  it('is idempotent across rescans — re-running writes no duplicate entities or links', async () => {
    await seedCollisionRepo()

    const first = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
    const second = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
    expect(second.entitiesUpserted).toBe(first.entitiesUpserted)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      expect(registry.entityCount()).toBe(3)
      expect(registry.listCollisions()).toHaveLength(1)
      const service = registry.findEntityByName('internal').find(e => e.kind === 'service')
      expect(service).toBeDefined()
      if (service) {
        // One link per (fact, entity, role) — no fan-out on repeat scans.
        expect(registry.linkedFactIds([service.id])).toHaveLength(1)
      }
    } finally {
      registry.close()
    }
  })

  it('records the repo itself as an entity when a repo has no manifests', async () => {
    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'bare-repo' })
    expect(stats.entitiesUpserted).toBe(1)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const repo = registry.findEntityByName('bare-repo')[0]
      expect(repo?.kind).toBe('repo')
    } finally {
      registry.close()
    }
  })

  it('writes nothing when KB_ENTITY_INDEX=false', async () => {
    await seedCollisionRepo()
    process.env.KB_ENTITY_INDEX = 'false'

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
    expect(stats).toEqual({ entitiesUpserted: 0, factsLinked: 0, collisions: 0 })

    const registry = new EntityRegistry(dbPath)
    try {
      expect(registry.entityCount()).toBe(0)
    } finally {
      registry.close()
    }
  })
})
