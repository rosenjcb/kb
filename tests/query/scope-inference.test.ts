import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@kb/core/core/types.js'
import { runEntityIndexCycle } from '@kb/core/core/entity-index-cycle.js'
import { inferQueryScope } from '@kb/core/query/scope-inference.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-scope-inference-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
  process.env.KB_ENTITY_SCOPE = undefined
})

/** Seed the #167 scenario: a service `internal` and a surface `Internal Services`. */
function seedCollisionScenario(): { serviceFact: string; surfaceFact: string } {
  const indexer = new SqliteKbIndexer({ dbPath })
  let serviceFact: string
  let surfaceFact: string
  try {
    serviceFact = indexer.upsertFact({
      factText: 'The internal service validates payment auth tokens.',
      triplet: { subject: 'internal', predicate: 'validates', object: 'payment auth tokens' },
      sourceKind: 'import_doc',
      sourceRef: 'payments-core/README.md#s1',
      gitRepo: 'payments-core',
    }).id
    surfaceFact = indexer.upsertFact({
      factText: 'Internal Services surface shows operational dashboards.',
      triplet: { subject: 'Internal Services', predicate: 'shows', object: 'operational dashboards' },
      sourceKind: 'import_doc',
      sourceRef: 'platform-ui/README.md#s1',
      gitRepo: 'platform-ui',
    }).id
  } finally {
    indexer.close()
  }

  const registry = new EntityRegistry(dbPath)
  try {
    const serviceId = registry.upsertEntity({
      kind: 'service',
      canonicalName: 'internal',
      gitRepo: 'payments-core',
      sourceKind: 'manifest',
    })
    const surfaceId = registry.upsertEntity({
      kind: 'surface',
      canonicalName: 'Internal Services',
      gitRepo: 'platform-ui',
      sourceKind: 'manifest',
    })
    registry.linkFact(serviceFact, serviceId, 'subject')
    registry.linkFact(surfaceFact, surfaceId, 'subject')
    registry.detectCollisions()
  } finally {
    registry.close()
  }
  return { serviceFact, surfaceFact }
}

describe('inferQueryScope — deterministic tier', () => {
  it('lands very_confident on a unique alias hit and hard-prunes the distinct_from sibling', async () => {
    const { surfaceFact } = seedCollisionScenario()

    const verdict = await inferQueryScope({
      dbPath,
      query: 'how does internal handle payment authentication?',
    })

    expect(verdict.unresolved).toBe(false)
    expect(verdict.method).toBe('alias')
    const landing = verdict.candidates.find(c => c.label === 'very_confident')
    expect(landing?.entity.canonicalName).toBe('internal')
    const ruledOut = verdict.candidates.find(c => c.label === 'certainly_incorrect')
    expect(ruledOut?.entity.canonicalName).toBe('Internal Services')
    // Only the sibling's LINKED facts are excluded — never anything unlinked.
    expect(verdict.excludedFactIds).toEqual([surfaceFact])
    expect(verdict.disclosure).toContain('internal service')
    expect(verdict.disclosure).toContain('not')
  })

  it('longest-alias match wins the span: "Internal Services" queries land on the surface', async () => {
    const { serviceFact } = seedCollisionScenario()

    const verdict = await inferQueryScope({
      dbPath,
      query: 'where are the Internal Services dashboards?',
    })

    const landing = verdict.candidates.find(c => c.label === 'very_confident')
    expect(landing?.entity.canonicalName).toBe('Internal Services')
    expect(verdict.excludedFactIds).toEqual([serviceFact])
  })

  it('never prunes when the ruled-out sibling has no linked facts (coverage rule)', async () => {
    const registry = new EntityRegistry(dbPath)
    try {
      registry.upsertEntity({ kind: 'service', canonicalName: 'internal', sourceKind: 'manifest' })
      registry.upsertEntity({ kind: 'surface', canonicalName: 'Internal Services', sourceKind: 'manifest' })
      registry.detectCollisions()
    } finally {
      registry.close()
    }

    const verdict = await inferQueryScope({ dbPath, query: 'how does internal work?' })
    expect(verdict.unresolved).toBe(false)
    expect(verdict.excludedFactIds).toEqual([])
  })

  it('returns unresolved when nothing matches — no positive identification, no exclusions', async () => {
    seedCollisionScenario()
    const verdict = await inferQueryScope({ dbPath, query: 'how do deployments roll back?' })
    expect(verdict.unresolved).toBe(true)
    expect(verdict.excludedFactIds).toEqual([])
  })

  it('returns unresolved on an empty registry and when KB_ENTITY_SCOPE=false', async () => {
    const empty = await inferQueryScope({ dbPath, query: 'how does internal work?' })
    expect(empty.unresolved).toBe(true)

    seedCollisionScenario()
    process.env.KB_ENTITY_SCOPE = 'false'
    const disabled = await inferQueryScope({ dbPath, query: 'how does internal work?' })
    expect(disabled.unresolved).toBe(true)
  })

  it('labels colliding multi-entity mentions confident and excludes nothing', async () => {
    seedCollisionScenario()
    const verdict = await inferQueryScope({
      dbPath,
      query: 'compare internal with the Internal Services surface',
    })
    expect(verdict.unresolved).toBe(false)
    expect(verdict.candidates.every(c => c.label === 'confident')).toBe(true)
    expect(verdict.excludedFactIds).toEqual([])
    expect(verdict.disclosure).toContain('multiple known things')
  })
})

describe('inferQueryScope — LLM classifier tier', () => {
  function fakeLlm(responseText: string): LLMProvider {
    return {
      name: 'fake',
      model: 'fake-model',
      supportsStreaming: false,
      call: async () => ({
        text: responseText,
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    }
  }

  it('caps LLM verdicts at confident — tier 2 never hard-prunes', async () => {
    seedCollisionScenario()
    const registry = new EntityRegistry(dbPath, { readOnly: true })
    const serviceId = registry.findEntityByName('internal')[0]?.id
    registry.close()

    const verdict = await inferQueryScope({
      dbPath,
      // No alias appears in the query — deterministic tier misses, LLM tier fires.
      query: 'how are payment tokens checked?',
      llm: fakeLlm(JSON.stringify([{ id: serviceId, label: 'very_confident' }])),
    })

    expect(verdict.unresolved).toBe(false)
    expect(verdict.method).toBe('llm')
    expect(verdict.candidates[0]?.label).toBe('confident')
    expect(verdict.excludedFactIds).toEqual([])
  })

  it('discards verdicts with no positive identification and survives malformed output', async () => {
    seedCollisionScenario()
    const registry = new EntityRegistry(dbPath, { readOnly: true })
    const serviceId = registry.findEntityByName('internal')[0]?.id
    registry.close()

    const allUnsure = await inferQueryScope({
      dbPath,
      query: 'how are payment tokens checked?',
      llm: fakeLlm(JSON.stringify([{ id: serviceId, label: 'very_unsure' }])),
    })
    expect(allUnsure.unresolved).toBe(true)

    const garbage = await inferQueryScope({
      dbPath,
      query: 'how are payment tokens checked?',
      llm: fakeLlm('I think it is probably the internal service.'),
    })
    expect(garbage.unresolved).toBe(true)
  })
})

describe('runEntityIndexCycle — end to end', () => {
  it('harvests, links units by exact alias match, and detects collisions', async () => {
    const scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-entity-cycle-scan-'))
    try {
      await mkdir(scanDir, { recursive: true })
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
        indexer.upsertCodeSymbol({
          gitRepo: 'payments-core',
          relPath: 'src/internal.ts',
          name: 'internal',
          kind: 'function',
          sourceText: 'export function internal() { return 1 }',
        })
      } finally {
        indexer.close()
      }

      const stats = await runEntityIndexCycle({ baseDir, scanDir, gitRepo: 'payments-core' })
      // repo + compose service + backstage component
      expect(stats.entitiesUpserted).toBe(3)
      expect(stats.factsLinked).toBeGreaterThanOrEqual(1)
      expect(stats.collisions).toBeGreaterThanOrEqual(1)

      const registry = new EntityRegistry(dbPath, { readOnly: true })
      try {
        const service = registry.findEntityByName('internal')
        expect(service.some(e => e.kind === 'service')).toBe(true)
        const collisions = registry.listCollisions()
        expect(
          collisions.some(
            c =>
              [c.fromEntity.canonicalName, c.toEntity.canonicalName].sort().join('|') ===
              'Internal Services|internal'
          )
        ).toBe(true)
      } finally {
        registry.close()
      }
    } finally {
      await rm(scanDir, { recursive: true, force: true })
    }
  })
})

describe('inferQueryScope — common-word aliases defer to the classifier', () => {
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

  function fakeLlm(responseText: string): LLMProvider {
    return {
      name: 'fake',
      model: 'fake-model',
      supportsStreaming: false,
      call: async () => ({
        text: responseText,
        stopReason: 'end_turn' as const,
        toolUses: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    }
  }

  it('does not let a bare common word hard-prune — it reaches tier 2 instead', async () => {
    seedRoleModel()

    // The classifier is asked, and here it correctly declines to land on `Role`.
    const verdict = await inferQueryScope({
      dbPath,
      query: 'what is the role of the tree-sitter indexer?',
      llm: fakeLlm(JSON.stringify({ candidates: [] })),
    })

    expect(verdict.unresolved).toBe(true)
    expect(verdict.excludedFactIds).toEqual([])
  })

  it('returns unresolved rather than guessing when no classifier is available', async () => {
    seedRoleModel()

    const verdict = await inferQueryScope({
      dbPath,
      query: 'what is the role of the tree-sitter indexer?',
    })

    expect(verdict.unresolved).toBe(true)
  })

  it('still lands deterministically when the query writes the identifier', async () => {
    seedRoleModel()

    const verdict = await inferQueryScope({
      dbPath,
      query: 'which values does the Role enum have?',
    })

    expect(verdict.unresolved).toBe(false)
    expect(verdict.method).toBe('alias')
    expect(verdict.candidates[0]?.entity.canonicalName).toBe('Role')
    expect(verdict.candidates[0]?.label).toBe('very_confident')
  })
})
