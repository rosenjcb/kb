import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn(async (_sql: string) => undefined)
const disconnect = vi.fn(() => undefined)
const connect = vi.fn(async () => ({ run, disconnect }))
const create = vi.fn(async () => ({ connect }))

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create,
  },
}))

describe('DuckGraphWriter.open', () => {
  afterEach(() => {
    run.mockClear()
    disconnect.mockClear()
    connect.mockClear()
    create.mockClear()
  })

  it('Given open is called, then it only performs table-backed schema setup', async () => {
    const { DuckGraphWriter } = await import('../../src/tools/duck-graph-writer')

    const writer = new DuckGraphWriter('/tmp/test.kb-graph.duckdb')
    await writer.open()

    const executedSql = run.mock.calls.map(([sql]) => String(sql))

    expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS entities'))).toBe(true)
    expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS relationships'))).toBe(
      true
    )
    expect(
      executedSql.some(sql =>
        sql.includes('ALTER TABLE entities ADD COLUMN IF NOT EXISTS description')
      )
    ).toBe(true)
    expect(executedSql.some(sql => sql.includes('INSTALL duckpgq'))).toBe(false)
    expect(executedSql.some(sql => sql.includes('LOAD duckpgq'))).toBe(false)
    expect(executedSql.some(sql => sql.includes('PROPERTY GRAPH'))).toBe(false)

    await writer.close()
  })
})
