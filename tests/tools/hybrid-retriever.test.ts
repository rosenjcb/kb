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

  it('[TC-EV21] Given a real embedder, then avgTop measures top-unit relevance and is higher on-topic', async () => {
    // #219: the evidence label reads retrieval relevance. Without an embedder, cosine is the
    // deterministic hash fallback and carries no relevance signal, so avgTop is deliberately
    // not measured — the caller must fall back to a count heuristic.
    const unmeasured = retrieveHybrid(indexer, { query: 'AuthService login', limit: 10 })
    expect(unmeasured.avgTop).toBeUndefined()

    // A tiny deterministic embedder: dim0 = "red" topic, dim1 = "blue" topic, dim2 = the shared
    // lexical anchor "widget", dim3 = a base so no vector has zero norm. Two docs share the
    // anchor (both retrieved by FTS) but sit on opposite topic axes.
    const topicVector = (text: string): number[] => {
      const t = text.toLowerCase()
      return [t.includes('red') ? 1 : 0, t.includes('blue') ? 1 : 0, t.includes('widget') ? 0.1 : 0, 0.01]
    }
    const fakeEmbedder = {
      modelId: 'fake-topic:4',
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(topicVector),
    }

    const embedded = new SqliteKbIndexer({ dbPath: join(tmpDir, 'embedded.sqlite'), embedder: fakeEmbedder })
    embedded.upsertDocument({
      gitRepo: 'demo',
      relPath: 'docs/red.md',
      title: 'Red widget guide',
      body: 'The red widget guide. red widget red widget.',
    })
    embedded.upsertDocument({
      gitRepo: 'demo',
      relPath: 'docs/blue.md',
      title: 'Blue widget guide',
      body: 'The blue widget guide. blue widget blue widget.',
    })
    await embedded.embedAll()

    // On-topic query embeds onto the "red" axis → the red doc scores ~1. Off-topic query shares
    // only the "widget" anchor → every retrieved unit scores near the orthogonal floor.
    await embedded.cacheQueryEmbedding('red widget')
    await embedded.cacheQueryEmbedding('green widget')
    const onTopic = retrieveHybrid(embedded, { query: 'red widget', limit: 10 })
    const offTopic = retrieveHybrid(embedded, { query: 'green widget', limit: 10 })
    embedded.close()

    expect(onTopic.units.length).toBeGreaterThan(0)
    expect(offTopic.units.length).toBeGreaterThan(0)
    expect(typeof onTopic.avgTop).toBe('number')
    expect(typeof offTopic.avgTop).toBe('number')
    // The whole point of #219: relevance, not result count, drives the number.
    expect(onTopic.avgTop as number).toBeGreaterThan(offTopic.avgTop as number)
    expect(onTopic.avgTop as number).toBeGreaterThan(0.5)
    expect(onTopic.avgTop as number).toBeLessThanOrEqual(1)
  })
})
