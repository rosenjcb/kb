import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildInquiryLanes } from '@kb/core/query/inquiry-lanes.js'
import { inferQueryScope } from '@kb/core/query/scope-inference.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-inquiry-lanes-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

/** An empty index still needs the schema, which the indexer creates on open. */
function initSchema(): void {
  const indexer = new SqliteKbIndexer({ dbPath })
  indexer.close()
}

/** `checkout` service, owned by `payments` team, inside `commerce` domain, depends on `ledger`. */
function seedServiceGraph(): void {
  initSchema()
  const registry = new EntityRegistry(dbPath)
  try {
    const service = registry.upsertEntity({
      kind: 'service',
      canonicalName: 'checkout',
      gitRepo: 'commerce-api',
      sourceKind: 'manifest',
    })
    const team = registry.upsertEntity({
      kind: 'team',
      canonicalName: 'payments',
      sourceKind: 'manifest',
    })
    const domain = registry.upsertEntity({
      kind: 'domain',
      canonicalName: 'commerce',
      sourceKind: 'manifest',
    })
    const ledger = registry.upsertEntity({
      kind: 'service',
      canonicalName: 'ledger',
      sourceKind: 'manifest',
    })
    registry.addEdge(service, team, 'owned_by')
    registry.addEdge(service, domain, 'belongs_to')
    registry.addEdge(service, ledger, 'depends_on')
  } finally {
    registry.close()
  }
}

describe('buildInquiryLanes — ontology-grounded facets', () => {
  it('turns real edges into ownership, locus and dependency lanes naming the neighbors', () => {
    seedServiceGraph()

    const lanes = buildInquiryLanes({ dbPath, query: 'how does checkout work?' })

    const byFacet = new Map(lanes.map(lane => [lane.facet, lane.query]))
    expect(byFacet.get('ownership')).toContain('payments')
    expect(byFacet.get('locus')).toContain('commerce')
    expect(byFacet.get('dependency')).toContain('ledger')
    // Every lane is anchored on the entity it was derived from.
    expect(lanes.every(lane => lane.query.includes('checkout'))).toBe(true)
  })

  it('conditions mechanism probes on entity kind — a model is vague differently than a cli', () => {
    initSchema()
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'model', canonicalName: 'Invoice', sourceKind: 'manifest' })
      registry.upsertEntity({ kind: 'cli', canonicalName: 'kbctl', sourceKind: 'manifest' })
    } finally {
      registry.close()
    }

    const modelLanes = buildInquiryLanes({ dbPath, query: 'tell me about Invoice' })
    const cliLanes = buildInquiryLanes({ dbPath, query: 'tell me about kbctl' })

    expect(modelLanes.some(l => l.query.includes('schema fields columns'))).toBe(true)
    expect(cliLanes.some(l => l.query.includes('commands subcommands'))).toBe(true)
    // The kind grid is the point: neither template leaks into the other.
    expect(modelLanes.some(l => l.query.includes('commands'))).toBe(false)
    expect(cliLanes.some(l => l.query.includes('schema'))).toBe(false)
  })

  it('is not gated on query length — a long vague question still gets targeted lanes', () => {
    seedServiceGraph()

    const lanes = buildInquiryLanes({
      dbPath,
      query: 'I have been wondering for a while now whether checkout is something we should worry about',
    })

    expect(lanes.length).toBeGreaterThan(0)
  })
})

describe('buildInquiryLanes — IS/IS-NOT stays a qualifier, never a lane', () => {
  it('qualifies lanes with the landing repo but never retrieves the distinct_from sibling', () => {
    initSchema()
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({
        kind: 'service',
        canonicalName: 'internal',
        gitRepo: 'payments-core',
        sourceKind: 'manifest',
      })
      registry.upsertEntity({
        kind: 'surface',
        canonicalName: 'Internal Services',
        gitRepo: 'platform-ui',
        sourceKind: 'manifest',
      })
      registry.detectCollisions()
    } finally {
      registry.close()
    }

    const lanes = buildInquiryLanes({ dbPath, query: 'how does internal work?' })

    expect(lanes.length).toBeGreaterThan(0)
    // The landing's own repo sharpens the lane...
    expect(lanes.every(lane => lane.query.includes('payments-core'))).toBe(true)
    // ...and the ruled-out sibling is never a retrieval target. Pulling its facts
    // back in would undo exactly what scope pruning exists to do.
    expect(lanes.some(lane => lane.query.toLowerCase().includes('platform-ui'))).toBe(false)
  })
})

describe('buildInquiryLanes — additivity', () => {
  it('returns no lanes when nothing resolves, leaving the caller on its existing path', () => {
    seedServiceGraph()

    expect(buildInquiryLanes({ dbPath, query: 'what about quarterly revenue?' })).toEqual([])
  })

  it('returns no lanes for an empty registry', () => {
    initSchema()

    expect(buildInquiryLanes({ dbPath, query: 'how does checkout work?' })).toEqual([])
  })

  it('returns no lanes for a missing database instead of throwing', () => {
    expect(
      buildInquiryLanes({ dbPath: path.join(baseDir, 'nope.sqlite'), query: 'checkout' })
    ).toEqual([])
  })

  it('does not land on repo entities — a repo match says little about the question', () => {
    initSchema()
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'repo', canonicalName: 'commerce-api', sourceKind: 'manifest' })
    } finally {
      registry.close()
    }

    expect(buildInquiryLanes({ dbPath, query: 'what is in commerce-api?' })).toEqual([])
  })
})

describe('buildInquiryLanes — scope verdict reuse', () => {
  it('builds lanes for the verdict landing so probes match the disclosed interpretation', async () => {
    seedServiceGraph()
    const verdict = await inferQueryScope({ dbPath, query: 'how does checkout work?' })

    const lanes = buildInquiryLanes({ dbPath, query: 'how does checkout work?', verdict })

    expect(lanes.length).toBeGreaterThan(0)
    expect(lanes.every(lane => lane.query.includes('checkout'))).toBe(true)
  })

  it('builds nothing from an unresolved verdict even when the query mentions an entity', () => {
    seedServiceGraph()

    const lanes = buildInquiryLanes({
      dbPath,
      query: 'how does checkout work?',
      verdict: { unresolved: true, candidates: [], excludedFactIds: [], method: 'none' },
    })

    expect(lanes).toEqual([])
  })
})

describe('buildInquiryLanes — common-word aliases do not aim retrieval', () => {
  /** The observed kb failure: a Prisma `Role` enum capturing "the role of …". */
  function seedRoleAndIndexer(): void {
    initSchema()
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'model', canonicalName: 'Role', sourceKind: 'source-pattern' })
    } finally {
      registry.close()
    }
  }

  it('builds no lanes for a common word used as ordinary prose', () => {
    seedRoleAndIndexer()

    // Previously this landed on the Prisma enum and pointed the fan-out at
    // database schema for a question about an indexer.
    expect(
      buildInquiryLanes({ dbPath, query: 'what is the role of the tree-sitter indexer?' })
    ).toEqual([])
  })

  it('still builds lanes when the query writes the identifier', () => {
    seedRoleAndIndexer()

    const lanes = buildInquiryLanes({ dbPath, query: 'which values does the Role enum have?' })

    expect(lanes.length).toBeGreaterThan(0)
    expect(lanes.some(l => l.query.includes('schema fields columns'))).toBe(true)
  })
})
