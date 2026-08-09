import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isDistinctiveAliasMatch } from '@kb/core/tools/common-word-aliases.js'
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

  it('splits CamelCase so prose can land on harvest names', () => {
    expect(normalizeEntityName('TreeSitterIndexer')).toBe('tree sitter indexer')
    expect(normalizeEntityName('tree-sitter indexer')).toBe('tree sitter indexer')
    expect(normalizeEntityName('HttpRequestHandler')).toBe('http request handler')
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
        sourceKind: 'import_doc',
        sourceRef: 'test:a',
      }).id
      factB = indexer.upsertFact({
        factText: 'The internal service emits metrics.',
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

describe('isDistinctiveAliasMatch', () => {
  it('lets a name that is not an English word through in any casing', () => {
    expect(isDistinctiveAliasMatch('kbctl', 'kbctl')).toBe(true)
    expect(isDistinctiveAliasMatch('Kestra', 'kestra')).toBe(true)
  })

  it('requires a capitalized common word to be echoed capitalized', () => {
    // "the Role enum" means the identifier; "the role of the indexer" does not.
    expect(isDistinctiveAliasMatch('Role', 'Role')).toBe(true)
    expect(isDistinctiveAliasMatch('Role', 'role')).toBe(false)
    expect(isDistinctiveAliasMatch('User', 'user')).toBe(false)
  })

  it('never trusts an all-lowercase common word — prose is lowercase too', () => {
    expect(isDistinctiveAliasMatch('facts', 'facts')).toBe(false)
    expect(isDistinctiveAliasMatch('service', 'service')).toBe(false)
  })

  it('exempts multi-token aliases — nobody writes "payment service" by accident', () => {
    expect(isDistinctiveAliasMatch('payment service', 'payment service')).toBe(true)
  })
})

describe('EntityRegistry — mention distinctiveness', () => {
  /** A Prisma-style `Role` enum, the real false-match from the kb index. */
  function seedRoleModel(): void {
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.close()
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'model', canonicalName: 'Role', sourceKind: 'source-pattern' })
    } finally {
      registry.close()
    }
  }

  it('marks a common word in ordinary prose non-distinctive but still reports it', () => {
    seedRoleModel()
    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const matches = registry.resolveMentions('what is the role of permissions here?')

      // The match is not hidden — it is disqualified from steering retrieval.
      expect(matches).toHaveLength(1)
      expect(matches[0]?.distinctive).toBe(false)
    } finally {
      registry.close()
    }
  })

  it('lands a CamelCase harvest name from hyphenated prose, while role stays non-distinctive', () => {
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.close()
    const writable = new EntityRegistry(dbPath)
    try {
      writable.upsertEntity({ kind: 'model', canonicalName: 'Role', sourceKind: 'source-pattern' })
      writable.upsertEntity({
        kind: 'module',
        canonicalName: 'TreeSitterIndexer',
        sourceKind: 'source-pattern',
      })
    } finally {
      writable.close()
    }

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const matches = registry.resolveMentions(
        'What is the role of the tree-sitter indexer in code indexing?'
      )
      const byName = Object.fromEntries(matches.map(m => [m.entity.canonicalName, m.distinctive]))
      expect(byName.Role).toBe(false)
      expect(byName.TreeSitterIndexer).toBe(true)
    } finally {
      registry.close()
    }
  })

  it('keeps the same alias distinctive when the query writes it as the identifier', () => {
    seedRoleModel()
    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const matches = registry.resolveMentions('which values does the Role enum have?')

      expect(matches).toHaveLength(1)
      expect(matches[0]?.distinctive).toBe(true)
    } finally {
      registry.close()
    }
  })

  it('matches a CamelCase identifier in the query to the same entity', () => {
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.close()
    const writable = new EntityRegistry(dbPath)
    try {
      writable.upsertEntity({
        kind: 'module',
        canonicalName: 'HttpRequestHandler',
        sourceKind: 'source-pattern',
      })
    } finally {
      writable.close()
    }

    const registry = new EntityRegistry(dbPath, { readOnly: true })
    try {
      const matches = registry.resolveMentions(
        'Does kb still use HttpRequestHandler for outbound calls?'
      )
      expect(matches).toHaveLength(1)
      expect(matches[0]?.entity.canonicalName).toBe('HttpRequestHandler')
      expect(matches[0]?.distinctive).toBe(true)
    } finally {
      registry.close()
    }
  })
})
