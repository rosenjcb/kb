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
