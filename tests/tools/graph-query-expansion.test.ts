import { describe, expect, it } from 'vitest'
import { expandQueryWithGraph, toGraphQuerySlugs } from '../../src/tools/graph-query-expansion'

describe('graph-query-expansion', () => {
  it('Given a freeform query, then slug extraction produces unigrams and bigrams for graph entity matching', () => {
    const slugs = toGraphQuerySlugs('How does config.json relate to kb graph?')
    // Unigrams (stop-word filtering removed short tokens, but "how"/"does" pass length > 2 check)
    expect(slugs).toContain('config')
    expect(slugs).toContain('json')
    expect(slugs).toContain('graph')
    // Bigrams for compound entity IDs like "config-json", "json-relate"
    expect(slugs).toContain('config-json')
    expect(slugs).toContain('json-relate')
    // Total slugs bounded by slice(0, 16)
    expect(slugs.length).toBeLessThanOrEqual(16)
  })

  it('Given graph expansion terms, then query expansion appends a bounded set including triplets', async () => {
    const graphWriter = {
      expandQuery: async () => [
        'kb query retrieves via read_facts',
        'retrieves_via',
        'retrieves via',
        'SQLite',
        'GraphStore',
        'Property Graph',
        'CLI',
        'Config',
        'Extra1',
        'Extra2',
        'Extra3',
        'Extra4',
        'Extra5',
        'Extra6',
        'Extra7',
        'Extra8',
        'Extra9',
        'Extra10',
        'Extra11',
        'Extra12',
      ],
    } as const

    const expanded = await expandQueryWithGraph('config json', graphWriter as never)

    expect(expanded).toBe(
      'config json kb query retrieves via read_facts retrieves_via retrieves via SQLite GraphStore Property Graph CLI Config Extra1 Extra2 Extra3 Extra4 Extra5 Extra6 Extra7 Extra8 Extra9 Extra10'
    )
  })

  it('Given graph lookup failure, then expansion falls back to the original query', async () => {
    const graphWriter = {
      expandQuery: async () => {
        throw new Error('graph offline')
      },
    } as const

    await expect(expandQueryWithGraph('config json', graphWriter as never)).resolves.toBe(
      'config json'
    )
  })

  it('Given a code store, appends code neighbor names after semantic terms', async () => {
    const graphWriter = {
      expandQuery: async () => ['SemanticTerm'],
    } as const

    const codeStore = {
      findCodeSymbolsByName: () => [
        { name: 'SqliteKbIndexer' },
        { name: 'KbGraphWriter' },
      ],
    } as never

    const expanded = await expandQueryWithGraph('indexer', graphWriter as never, codeStore)
    expect(expanded).toContain('SemanticTerm')
    expect(expanded).toContain('SqliteKbIndexer')
    expect(expanded).toContain('KbGraphWriter')
  })

  it('Given code store failure, semantic expansion still succeeds', async () => {
    const graphWriter = {
      expandQuery: async () => ['SemanticTerm'],
    } as const

    const codeStore = {
      findCodeSymbolsByName: () => { throw new Error('code graph offline') },
    } as never

    const expanded = await expandQueryWithGraph('indexer', graphWriter as never, codeStore)
    expect(expanded).toContain('SemanticTerm')
  })
})
