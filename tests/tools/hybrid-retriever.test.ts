import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { retrieveHybrid } from '@kb/core/tools/hybrid-retriever.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let tmpDir: string
let indexer: SqliteKbIndexer

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-hybrid-'))
  indexer = new SqliteKbIndexer({ dbPath: join(tmpDir, '.kb-index.sqlite') })
  const { id: docId } = indexer.upsertDocument({
    gitRepo: 'demo',
    relPath: 'docs/auth.md',
    title: 'AuthService overview',
    body: 'AuthService handles login tokens and session cookies for the REST API.',
  })
  const { id: symbolId } = indexer.upsertCodeSymbol({
    gitRepo: 'demo',
    relPath: 'src/auth.ts',
    name: 'AuthService',
    kind: 'class',
    sourceText: 'export class AuthService { login() {} }',
  })
  indexer.replaceDocCodeLinks(docId, [{ symbolId, score: 1, linkKind: 'documents' }])
  indexer.upsertCuratedFact({
    text: 'AuthService is the login entrypoint.',
    gitRepo: 'demo',
  })
})

afterEach(async () => {
  indexer.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hybrid-retriever', () => {
  it('[TC-0V13] hybrid retrieval returns ranked documents and code symbols for a natural-language query', () => {
    const result = retrieveHybrid(indexer, {
      query: 'AuthService login cookies',
      limit: 10,
      includeContent: true,
    })
    expect(result.units.length).toBeGreaterThan(0)
    const kinds = new Set(
      result.units.map(u => {
        if (u.metadata.tags?.includes('document')) return 'document'
        if (u.metadata.tags?.includes('symbol')) return 'symbol'
        if (u.metadata.tags?.includes('fact')) return 'fact'
        return 'other'
      })
    )
    expect(kinds.has('document') || kinds.has('symbol')).toBe(true)
  })

  it('[TC-DZZT] hybrid retrieval detail reports docs/symbols/facts/hops counts', () => {
    const result = retrieveHybrid(indexer, { query: 'AuthService', limit: 5 })
    expect(result.detail).toMatch(/^hybrid:docs=\d+,symbols=\d+,facts=\d+,hops=\d+$/)
    expect(result.counts).toMatchObject({
      document: expect.any(Number),
      symbol: expect.any(Number),
      fact: expect.any(Number),
      hops: expect.any(Number),
    })
  })

  it('[TC-71GI] one-hop join surfaces symbols linked from a top document', () => {
    const result = retrieveHybrid(indexer, {
      query: 'AuthService overview session cookies',
      limit: 20,
      includeContent: false,
    })
    const names = result.units.map(u => u.metadata.symbol ?? u.metadata.title).join(' ')
    expect(names).toMatch(/AuthService/)
    expect(result.counts.hops + result.counts.symbol).toBeGreaterThan(0)
  })

  it('[TC-O0JK] kind weighting lets a narrow symbol outrank a broad document tied on rank (#216)', () => {
    indexer.upsertDocument({
      gitRepo: 'demo',
      relPath: 'docs/gizmo-guide.md',
      title: 'Gizmo platform guide',
      body: 'This guide covers the gizmo platform end to end, including setup, configuration, and troubleshooting for every gizmo subsystem.',
    })
    indexer.upsertCodeSymbol({
      gitRepo: 'demo',
      relPath: 'src/gizmo.ts',
      name: 'renderGizmo',
      kind: 'function',
      sourceText: 'export function renderGizmo() { /* gizmo */ }',
    })

    const rankOf = (units: ReturnType<typeof retrieveHybrid>['units'], tag: 'document' | 'symbol') =>
      units.findIndex(u => u.metadata.tags?.includes(tag))

    // Both lanes match at rank 0, so plain RRF would tie them — kind weighting always applies,
    // so the symbol (1.15x) outranks the document (0.9x) even at an equal rank position.
    const weighted = retrieveHybrid(indexer, { query: 'gizmo', limit: 10 })
    expect(rankOf(weighted.units, 'symbol')).toBeLessThan(rankOf(weighted.units, 'document'))
  })
})

describe('named-symbol lane (#238)', () => {
  afterEach(() => {
    process.env.KB_QUERY_SYMBOL_LANE = undefined
  })

  it('[TC-SYL1] Given the lane is off, then detail omits named= entirely so "off" stays distinguishable from "ran, matched nothing"', () => {
    process.env.KB_QUERY_SYMBOL_LANE = undefined
    const { detail } = retrieveHybrid(indexer, { query: 'AuthService login' })
    expect(detail).not.toContain('named=')
  })

  it('[TC-SYL2] Given the lane is on and the query names a declaration, then the declaring file is retrieved and counted', () => {
    process.env.KB_QUERY_SYMBOL_LANE = 'true'
    const { units, detail } = retrieveHybrid(indexer, { query: 'what does AuthService do?' })
    expect(detail).toMatch(/named=[1-9]/)
    expect(units.some(u => u.metadata.sourcePath === 'demo/src/auth.ts')).toBe(true)
  })

  it('[TC-SYL3] Given the lane is on and the query names nothing declared, then it reports zero rather than going absent', () => {
    process.env.KB_QUERY_SYMBOL_LANE = 'true'
    const { detail } = retrieveHybrid(indexer, { query: 'wombat marsupial burrows' })
    expect(detail).toContain('named=0')
  })

  it('[TC-SYL4] Given a lowercase prose mention of a CamelCase declaration, then it still resolves', () => {
    process.env.KB_QUERY_SYMBOL_LANE = 'true'
    const { units } = retrieveHybrid(indexer, { query: 'how does the authservice issue tokens?' })
    expect(units.some(u => u.metadata.sourcePath === 'demo/src/auth.ts')).toBe(true)
  })
})
