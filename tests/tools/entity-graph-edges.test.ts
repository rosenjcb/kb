import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runEntityIndexCycle } from '@kb/core/core/entity-index-cycle.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'

/**
 * Edges are what make the entity registry a graph rather than a bag of names, so these
 * exercise the harvest end to end: a harvester emits a candidate edge, and the index
 * cycle resolves both endpoints against the base. A bug in either half shows up as a
 * missing edge, so neither half can be verified alone.
 */

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
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-edges-base-'))
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-edges-scan-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
  await rm(scanDir, { recursive: true, force: true })
})

describe('harvested relationship edges', () => {
  /**
   * The bug this guards: the harvester emitted `part_of` edges pointing at the
   * workspace root by name, but the root was never harvested as a candidate, so both
   * endpoints had to resolve and the edge was dropped with no counter and no log. Every
   * workspace repo that did not happen to list `.` in its workspace globs shipped zero
   * `part_of` edges.
   */
  it('[TC-ZI70] writes workspace part_of edges when the root is not a workspace member', async () => {
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
  it('[TC-QGZY] attaches harvested packages to the repo entity', async () => {
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
  it('[TC-29IO] derives containment for source-pattern entities from their source file', async () => {
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
  it('[TC-8Z1A] writes depends_on between packages and counts third-party targets as external', async () => {
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
  it('[TC-R7M5] degrades cleanly when nothing can be harvested', async () => {
    await writeFile(path.join(scanDir, 'main.zig'), 'pub fn main() void {}\n')

    const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'zig-repo' })
    // Only the repo entity; no edges to write and, crucially, none lost.
    expect(stats.entitiesUpserted).toBe(1)
    expect(stats.edgesWritten).toBe(0)
    expect(stats.edgesDropped).toBe(0)
  })
})
