import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EntityRegistry, normalizeEntityName } from '@kb/core/tools/entity-registry.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-registry-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('normalizeEntityName', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeEntityName('Internal  Services')).toBe('internal services')
    expect(normalizeEntityName('@acme/payments-service')).toBe('acme payments service')
    expect(normalizeEntityName('  KB_Server ')).toBe('kb server')
  })
})

describe('EntityRegistry', () => {
  it('upserts entities idempotently and returns them by name or alias', () => {
    const registry = new EntityRegistry(dbPath)
    try {
      const id1 = registry.upsertEntity({
        kind: 'service',
        canonicalName: 'internal',
        gitRepo: 'payments-core',
        sourceKind: 'manifest',
      })
      const id2 = registry.upsertEntity({
        kind: 'service',
        canonicalName: 'internal',
        sourceKind: 'manifest',
      })
      expect(id1).toBe(id2)
      expect(registry.entityCount()).toBe(1)

      registry.addAlias(id1, 'internal-svc', 'manifest')
      const byAlias = registry.findEntityByName('Internal-Svc')
      expect(byAlias).toHaveLength(1)
      expect(byAlias[0]?.canonicalName).toBe('internal')
      expect(byAlias[0]?.gitRepo).toBe('payments-core')
    } finally {
      registry.close()
    }
  })

  it('never overwrites manual entities with automated re-harvests', () => {
    const registry = new EntityRegistry(dbPath)
    try {
      const id = registry.upsertEntity({
        kind: 'service',
        canonicalName: 'internal',
        gloss: 'hand-written gloss',
        sourceKind: 'manual',
      })
      registry.upsertEntity({
        kind: 'service',
        canonicalName: 'internal',
        gloss: 'harvested gloss',
        sourceKind: 'manifest',
      })
      expect(registry.getEntityById(id)?.gloss).toBe('hand-written gloss')
      expect(registry.getEntityById(id)?.sourceKind).toBe('manual')
    } finally {
      registry.close()
    }
  })

  it('resolves mentions by longest alias first — "internal services" never leaks to "internal"', () => {
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'service', canonicalName: 'internal', sourceKind: 'manifest' })
      registry.upsertEntity({
        kind: 'surface',
        canonicalName: 'Internal Services',
        sourceKind: 'manifest',
      })

      const surfaceOnly = registry.resolveMentions('what is the Internal Services status page?')
      expect(surfaceOnly).toHaveLength(1)
      expect(surfaceOnly[0]?.entity.canonicalName).toBe('Internal Services')

      const serviceOnly = registry.resolveMentions('how does internal handle authentication?')
      expect(serviceOnly).toHaveLength(1)
      expect(serviceOnly[0]?.entity.canonicalName).toBe('internal')
    } finally {
      registry.close()
    }
  })

  it('detects token-boundary name collisions and writes distinct_from edges with glosses', () => {
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
      registry.upsertEntity({ kind: 'service', canonicalName: 'billing', sourceKind: 'manifest' })

      const written = registry.detectCollisions()
      expect(written).toBe(1)

      const collisions = registry.listCollisions()
      expect(collisions).toHaveLength(1)
      const pair = [collisions[0]?.fromEntity.canonicalName, collisions[0]?.toEntity.canonicalName].sort()
      expect(pair).toEqual(['Internal Services', 'internal'])
      expect(collisions[0]?.gloss).toContain('payments-core')
      expect(collisions[0]?.gloss).toContain('platform-ui')
    } finally {
      registry.close()
    }
  })

  it('does not flag non-overlapping names ("internal" vs "internally-batched" is not token-boundary)', () => {
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'service', canonicalName: 'internal', sourceKind: 'manifest' })
      registry.upsertEntity({ kind: 'library', canonicalName: 'internally batched', sourceKind: 'manifest' })
      // "internal" is not a whole token of "internally batched".
      expect(registry.detectCollisions()).toBe(0)
    } finally {
      registry.close()
    }
  })

  it('links facts to entities and returns only linked fact ids', () => {
    const indexer = new SqliteKbIndexer({ dbPath })
    let factA: string
    let factB: string
    try {
      factA = indexer.upsertFact({
        factText: 'The internal service validates auth tokens.',
        triplet: { subject: 'internal', predicate: 'validates', object: 'auth tokens' },
        sourceKind: 'import_doc',
        sourceRef: 'test:a',
      }).id
      factB = indexer.upsertFact({
        factText: 'The internal service emits metrics.',
        triplet: { subject: 'internal', predicate: 'emits', object: 'metrics' },
        sourceKind: 'import_doc',
        sourceRef: 'test:b',
      }).id
    } finally {
      indexer.close()
    }

    const registry = new EntityRegistry(dbPath)
    try {
      const id = registry.upsertEntity({ kind: 'service', canonicalName: 'internal', sourceKind: 'manifest' })
      expect(registry.hasLinks(id)).toBe(false)
      registry.linkFact(factA, id, 'subject')
      registry.linkFact(factB, id, 'object')
      registry.linkFact(factA, id, 'subject') // idempotent
      expect(registry.hasLinks(id)).toBe(true)
      expect(registry.linkedFactIds([id]).sort()).toEqual([factA, factB].sort())
      expect(registry.linkedFactIds([])).toEqual([])
    } finally {
      registry.close()
    }
  })
})
