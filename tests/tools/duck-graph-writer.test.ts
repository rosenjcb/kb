import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckGraphWriter } from '../../src/tools/duck-graph-writer'

let tmpDir: string
let dbPath: string
let writer: DuckGraphWriter

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-graph-test-'))
  dbPath = join(tmpDir, '.kb-graph.duckdb')
  writer = new DuckGraphWriter(dbPath)
  await writer.open()
})

afterEach(async () => {
  await writer.close().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

const entity = (id: string) => ({ id, name: id, type: 'concept' as const })
const rel = (fromId: string, toId: string) => ({
  fromId,
  toId,
  type: 'related_to' as const,
  weight: 1.0,
})

describe('DuckGraphWriter transactions', () => {
  it('Given a committed transaction, then entities persist after close/reopen', async () => {
    await writer.beginTransaction()
    await writer.upsertEntities([entity('alpha'), entity('beta')])
    await writer.commit()
    await writer.close()

    const reader = new DuckGraphWriter(dbPath)
    try {
      const summary = await reader.getSummary()
      expect(summary.totalEntities).toBe(2)
    } finally {
      await reader.close()
    }
  })

  it('Given a rolled-back transaction, then no entities persist', async () => {
    await writer.beginTransaction()
    await writer.upsertEntities([entity('alpha'), entity('beta')])
    await writer.rollback()

    const summary = await writer.getSummary()
    expect(summary.totalEntities).toBe(0)
  })

  it('Given a rollback mid-relationship batch, then no partial data remains', async () => {
    await writer.upsertEntities([entity('pre-existing')])

    await writer.beginTransaction()
    await writer.upsertEntities([entity('new-a'), entity('new-b')])
    await writer.upsertRelationships([rel('new-a', 'new-b')])
    await writer.rollback()

    const summary = await writer.getSummary()
    // Only the pre-existing entity should remain; the transaction rolled back
    expect(summary.totalEntities).toBe(1)
    expect(summary.totalRelationships).toBe(0)
  })

  it('Given a committed relationship, then edge count reflects in summary', async () => {
    await writer.beginTransaction()
    await writer.upsertEntities([entity('x'), entity('y')])
    await writer.upsertRelationships([rel('x', 'y')])
    await writer.commit()

    const summary = await writer.getSummary()
    expect(summary.totalEntities).toBeGreaterThanOrEqual(2)
    expect(summary.totalRelationships).toBe(1)
  })
})

describe('DuckGraphWriter close', () => {
  it('close() resolves without throwing', async () => {
    await expect(writer.close()).resolves.toBeUndefined()
  })

  it('calling close() twice does not throw', async () => {
    await writer.close()
    await expect(writer.close()).resolves.toBeUndefined()
  })
})

describe('DuckGraphWriter.dbPathForBase', () => {
  it('returns .kb-graph.duckdb inside baseDir', () => {
    expect(DuckGraphWriter.dbPathForBase('/some/base')).toBe('/some/base/.kb-graph.duckdb')
  })
})

describe('DuckGraphWriter.expandQuery', () => {
  it('Given edges touching slugged entities, then expansion includes triplet phrases and verbs', async () => {
    await writer.upsertEntities([
      { id: 'alpha', name: 'Alpha Node', type: 'concept' },
      { id: 'beta', name: 'Beta Node', type: 'concept' },
    ])
    await writer.upsertRelationships([{ fromId: 'alpha', toId: 'beta', type: 'feeds_into' }])

    const terms = await writer.expandQuery(['alpha'])
    expect(terms.some(t => t.includes('Alpha Node') && t.includes('feeds into') && t.includes('Beta Node'))).toBe(
      true
    )
    expect(terms).toContain('feeds_into')
    expect(terms).toContain('feeds into')
  })
})

describe('DuckGraphWriter entity resolution and manual edges', () => {
  it('Given entity stored by id, then resolveEntityRef finds it by display name', async () => {
    await writer.upsertEntities([{ id: 'auth-svc', name: 'Auth service', type: 'system' }])
    await expect(writer.resolveEntityRef('Auth service')).resolves.toBe('auth-svc')
    await expect(writer.resolveEntityRef('auth-svc')).resolves.toBe('auth-svc')
  })

  it('Given a live edge, then softDeleteEdge retires it from the active count', async () => {
    await writer.upsertEntities([{ id: 'x', name: 'x', type: 'concept' }])
    await writer.upsertEntities([{ id: 'y', name: 'y', type: 'concept' }])
    await writer.upsertRelationships([{ fromId: 'x', toId: 'y', type: 'uses' }])
    expect(await writer.softDeleteEdge('x', 'y', 'uses')).toBe(1)
    const summary = await writer.getSummary()
    expect(summary.totalRelationships).toBe(0)
  })

  it('Given a free-text verb, then relationship type is normalized to snake_case', async () => {
    await writer.upsertEntities([{ id: 'a', name: 'a', type: 'concept' }])
    await writer.upsertEntities([{ id: 'b', name: 'b', type: 'concept' }])
    await writer.upsertRelationships([{ fromId: 'a', toId: 'b', type: 'Powers Index' }])
    const exported = await writer.exportJson()
    expect(exported.relationships[0]?.type).toBe('powers_index')
  })

  it('getEntityNameById returns display name for canonical id', async () => {
    await writer.upsertEntities([{ id: 'svc-1', name: 'My Service', type: 'system' }])
    await expect(writer.getEntityNameById('svc-1')).resolves.toBe('My Service')
  })

  it('getDirectedEdgeLabelsBetween returns active edge types in order', async () => {
    await writer.upsertEntities([
      { id: 'n1', name: 'n1', type: 'concept' },
      { id: 'n2', name: 'n2', type: 'concept' },
    ])
    await writer.upsertRelationships([{ fromId: 'n1', toId: 'n2', type: 'depends_on' }])
    await expect(writer.getDirectedEdgeLabelsBetween('n1', 'n2')).resolves.toEqual(['depends_on'])
    await expect(writer.getDirectedEdgeLabelsBetween('n2', 'n1')).resolves.toEqual([])
  })
})

describe('DuckGraphWriter concurrent writes', () => {
  it('Given parallel writers for the same db, then writes are serialized and both succeed', async () => {
    const writerA = new DuckGraphWriter(dbPath)
    const writerB = new DuckGraphWriter(dbPath)

    try {
      await Promise.all([
        writerA.upsertEntities([{ id: 'parallel-a', name: 'Parallel A', type: 'concept' }]),
        writerB.upsertEntities([{ id: 'parallel-b', name: 'Parallel B', type: 'concept' }]),
      ])

      const reader = new DuckGraphWriter(dbPath)
      try {
        const exported = await reader.exportJson()
        expect(exported.entities.some(entity => entity.id === 'parallel-a')).toBe(true)
        expect(exported.entities.some(entity => entity.id === 'parallel-b')).toBe(true)
      } finally {
        await reader.close()
      }
    } finally {
      await writerA.close().catch(() => {})
      await writerB.close().catch(() => {})
    }
  })
})
