import { describe, expect, it } from 'vitest'
import { expandQueryWithGraph, toGraphQuerySlugs } from '../../src/tools/graph-query-expansion'

describe('graph-query-expansion', () => {
  it('Given a freeform query, then slug extraction keeps only useful graph tokens', () => {
    expect(toGraphQuerySlugs('How does config.json relate to kb graph?')).toEqual([
      'how',
      'does',
      'config',
      'json',
      'relate',
      'graph',
    ])
  })

  it('Given graph neighbors, then query expansion appends a bounded set of neighbor names', async () => {
    const graphWriter = {
      expandQuery: async () => ['SQLite', 'DuckDB', 'Property Graph', 'CLI', 'Config', 'Ignored'],
    } as const

    const expanded = await expandQueryWithGraph('config json', graphWriter as never)

    expect(expanded).toBe('config json SQLite DuckDB Property Graph CLI Config')
  })

  it('Given graph lookup failure, then expansion falls back to the original query', async () => {
    const graphWriter = {
      expandQuery: async () => {
        throw new Error('graph offline')
      },
    } as const

    await expect(expandQueryWithGraph('config json', graphWriter as never)).resolves.toBe('config json')
  })
})
