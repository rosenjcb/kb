import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runEntityIndexCycle } from '@kb/core/core/entity-index-cycle.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

/** Edge types written between two entities, in either direction. */
function edgeTypesBetween(indexPath: string, a: string, b: string): string[] {
  const db = new DatabaseSync(indexPath, { readOnly: true })
  try {
    return (
      db
        .prepare(
          `SELECT edge_type FROM entity_edges
           WHERE (from_entity_id = ? AND to_entity_id = ?)
              OR (from_entity_id = ? AND to_entity_id = ?)`
        )
        .all(a, b, b, a) as Array<{ edge_type: string }>
    ).map(row => row.edge_type)
  } finally {
    db.close()
  }
}

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

  /**
   * The bug this guards: the harvester emitted `part_of` edges pointing at the
   * workspace root by name, but the root was never harvested as a candidate, so both
   * endpoints had to resolve and the edge was dropped with no counter and no log. Every
   * workspace repo that did not happen to list `.` in its workspace globs shipped zero
   * `part_of` edges.
   */
  it('[TC-36] writes workspace part_of edges when the root is not a workspace member', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({ name: 'acme-monorepo', workspaces: ['packages/*'] })
    )
    await mkdir(path.join(scanDir, 'packages', 'api'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'packages', 'api', 'package.json'),
      JSON.stringify({ name: '@acme/api', dependencies: { express: '^4' } })
    )

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'acme' })
    expect(stats.edgesWritten).toBeGreaterThan(0)
    // A structural endpoint that cannot be resolved is a harvester bug, never silent.
    expect(stats.edgesDropped).toBe(0)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const member = registry.findEntityByName('@acme/api')[0]
      const root = registry.findEntityByName('acme-monorepo')[0]
      expect(member).toBeDefined()
      expect(root).toBeDefined()
      if (!member || !root) return
      expect(edgeTypesBetween(dbPath, member.id, root.id)).toContain('part_of')
    } finally {
      registry.close()
    }
  })

  /**
   * The repo entity was upserted but never registered as a resolvable edge endpoint,
   * so nothing could ever be `part_of` the repo it lives in.
   */
  it('[TC-37] attaches harvested packages to the repo entity', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({ name: 'solo-service', dependencies: { express: '^4' } })
    )

    await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'solo-repo' })

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const pkg = registry.findEntityByName('solo-service')[0]
      const repo = registry.findEntityByName('solo-repo')[0]
      expect(pkg).toBeDefined()
      expect(repo).toBeDefined()
      if (!pkg || !repo) return
      expect(edgeTypesBetween(dbPath, pkg.id, repo.id)).toContain('part_of')
    } finally {
      registry.close()
    }
  })

  /**
   * Tier-4 entities (routes, models, modules) are the bulk of every registry and had no
   * edges at all: `pattern-engine` emits candidates only. Containment is derivable from
   * the source file each candidate already carries.
   */
  it('[TC-38] derives containment for source-pattern entities from their source file', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({ name: 'acme-monorepo', workspaces: ['packages/*'] })
    )
    await mkdir(path.join(scanDir, 'packages', 'api', 'prisma'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'packages', 'api', 'package.json'),
      JSON.stringify({ name: '@acme/api' })
    )
    await writeFile(
      path.join(scanDir, 'packages', 'api', 'prisma', 'schema.prisma'),
      'model Invoice {\n  id Int @id\n}\n'
    )

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'acme' })
    expect(stats.edgesDropped).toBe(0)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const model = registry.findEntityByName('Invoice')[0]
      const pkg = registry.findEntityByName('@acme/api')[0]
      expect(model).toBeDefined()
      expect(pkg).toBeDefined()
      if (!model || !pkg) return
      // The nearest enclosing package owns it, not the repo root.
      expect(edgeTypesBetween(dbPath, model.id, pkg.id)).toContain('part_of')
    } finally {
      registry.close()
    }
  })

  /**
   * Dependency lists were parsed on every scan for the kind rubric and then discarded,
   * so `depends_on` had no writer anywhere in the codebase.
   */
  it('[TC-39] writes depends_on between packages and counts third-party targets as external', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({ name: 'acme-monorepo', workspaces: ['packages/*'] })
    )
    await mkdir(path.join(scanDir, 'packages', 'api'), { recursive: true })
    await mkdir(path.join(scanDir, 'packages', 'core'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@acme/core' })
    )
    await writeFile(
      path.join(scanDir, 'packages', 'api', 'package.json'),
      JSON.stringify({ name: '@acme/api', dependencies: { '@acme/core': '*', express: '^4' } })
    )

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'acme' })
    // `express` is not an entity this base knows — external, not a dropped edge.
    expect(stats.edgesExternal).toBeGreaterThan(0)
    expect(stats.edgesDropped).toBe(0)

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const api = registry.findEntityByName('@acme/api')[0]
      const core = registry.findEntityByName('@acme/core')[0]
      expect(api).toBeDefined()
      expect(core).toBeDefined()
      if (!api || !core) return
      expect(edgeTypesBetween(dbPath, api.id, core.id)).toContain('depends_on')
      // A third-party dependency never becomes a stub entity.
      expect(registry.findEntityByName('express')).toHaveLength(0)
    } finally {
      registry.close()
    }
  })

  /**
   * A repo in an ecosystem with no YAML profile (and no manifest of any kind) must
   * degrade to a clean no-op rather than a broken or half-written registry.
   */
  it('[TC-40] degrades cleanly when nothing can be harvested', async () => {
    await writeFile(path.join(scanDir, 'main.zig'), 'pub fn main() void {}\n')

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'zig-repo' })
    // Only the repo entity; no edges to write and, crucially, none lost.
    expect(stats.entitiesUpserted).toBe(1)
    expect(stats.edgesWritten).toBe(0)
    expect(stats.edgesDropped).toBe(0)
  })

  it('writes nothing when KB_ENTITY_INDEX=false', async () => {
    await seedCollisionRepo()
    process.env.KB_ENTITY_INDEX = 'false'

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
    expect(stats).toEqual({
      entitiesUpserted: 0,
      factsLinked: 0,
      collisions: 0,
      edgesWritten: 0,
      edgesExternal: 0,
      edgesDropped: 0,
    })

    const registry = new EntityRegistry(dbPath)
    try {
      expect(registry.entityCount()).toBe(0)
    } finally {
      registry.close()
    }
  })
})
