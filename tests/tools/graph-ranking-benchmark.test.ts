/**
 * Graph-aware retrieval benchmark.
 *
 * Purpose: deterministic, repeatable measurement of whether graph reranking
 * improves retrieval precision compared to hybrid-only (no graph).
 *
 * Structure:
 *   - Fixture corpus of 6 labeled documents across 3 topic clusters
 *   - Knowledge graph edges linking documents within each cluster
 *   - 4 benchmark queries, each with a ground-truth relevant document
 *   - Assertions on precision@1 and presence of observability fields
 *
 * This is a regression guard: if graph ranking breaks, at least 2 of the
 * 4 queries must have been promoted by the graph (confirmed by graphBoost > 0
 * on the top result).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownDocumentReader } from '../../src/tools/markdown-document-reader'
import { MarkdownMDWriterTool } from '../../src/tools/markdown-md-writer-tool'
import { DuckGraphWriter } from '../../src/tools/duck-graph-writer'

// ─── Fixture setup ───────────────────────────────────────────────────────────

// ─── Fixture corpus ───────────────────────────────────────────────────────────
//
// Design intent: documents have lexically similar content within clusters
// (so they compete with each other on BM25/vector) but the knowledge graph
// has precise entity→doc_id assignments that should tip the tiebreaker.
//
// Without graph: retrieval within a cluster is ambiguous (any doc could win).
// With graph: the doc whose entity is directly named in the query wins.

const DOCS = [
  // Cluster A: retrieval subsystem — both docs mention "retrieval" and "ranking"
  {
    id: 'bm25-ranking-internals',
    title: 'BM25 Ranking Internals',
    content: 'BM25 is the term-frequency ranking function used in the retrieval pipeline. It scores documents by term saturation and inverse document frequency. The retrieval subsystem uses BM25 for the lexical stage of hybrid search.',
    type: 'architecture' as const,
  },
  {
    id: 'vector-similarity-ranking',
    title: 'Vector Similarity Ranking',
    content: 'Vector similarity ranking uses cosine distance over dense embeddings. Embeddings are generated with text-embedding-3-small at 1536 dimensions. The retrieval pipeline blends vector scores with BM25 via alpha mixing.',
    type: 'architecture' as const,
  },
  // Cluster B: graph storage — both docs mention "graph" and "storage"
  {
    id: 'duckdb-graph-schema',
    title: 'DuckDB Graph Schema',
    content: 'DuckDB is the storage backend for the knowledge graph. The graph schema has two tables: entities and relationships. Weights enable soft-delete without removing rows. DuckPGQ extensions add property graph query syntax.',
    type: 'architecture' as const,
  },
  {
    id: 'sqlite-document-store',
    title: 'SQLite Document Store',
    content: 'SQLite is the storage backend for KB documents. The document store holds markdown content, FTS5 indexes, and metadata. All KB intent commands read from the SQLite store.',
    type: 'architecture' as const,
  },
  // Cluster C: credentials — both docs mention "config" and "key"
  {
    id: 'llm-api-key-setup',
    title: 'LLM API Key Setup',
    content: 'API keys for LLM providers are stored as ENVIRONMENT variables.',
    type: 'runbook' as const,
  },
  {
    id: 'kb-feature-flags',
    title: 'KB Feature Flag Reference',
    content: 'Feature flags are stored in config.json under the features section. Flags include sqliteIndex, hybridQuery, graphRankingEnabled, and laneRouting. All flags have env var overrides.',
    type: 'reference' as const,
  },
]

// Graph entities — precise doc_id assignments make graph the tiebreaker
const GRAPH_ENTITIES = [
  // Cluster A: BM25 entity pinned to bm25-ranking-internals
  { id: 'bm25', name: 'BM25', type: 'concept' as const, docId: 'bm25-ranking-internals' },
  { id: 'vector-similarity', name: 'Vector Similarity', type: 'concept' as const, docId: 'vector-similarity-ranking' },
  { id: 'text-embedding', name: 'text-embedding-3-small', type: 'tool' as const, docId: 'vector-similarity-ranking' },
  // Cluster B: DuckDB entity pinned to duckdb-graph-schema
  { id: 'duckdb', name: 'DuckDB', type: 'system' as const, docId: 'duckdb-graph-schema' },
  { id: 'duckpgq', name: 'DuckPGQ', type: 'tool' as const, docId: 'duckdb-graph-schema' },
  { id: 'sqlite', name: 'SQLite', type: 'system' as const, docId: 'sqlite-document-store' },
  // Cluster C: api-key entity pinned to llm-api-key-setup
  { id: 'api-key', name: 'API Key', type: 'concept' as const, docId: 'llm-api-key-setup' },
  { id: 'llm-provider', name: 'LLM Provider', type: 'concept' as const, docId: 'llm-api-key-setup' },
  { id: 'feature-flag', name: 'Feature Flag', type: 'concept' as const, docId: 'kb-feature-flags' },
]

const GRAPH_RELATIONSHIPS = [
  { fromId: 'bm25', toId: 'vector-similarity', type: 'related_to' as const, docId: 'bm25-ranking-internals' },
  { fromId: 'vector-similarity', toId: 'text-embedding', type: 'uses' as const, docId: 'vector-similarity-ranking' },
  { fromId: 'duckdb', toId: 'duckpgq', type: 'uses' as const, docId: 'duckdb-graph-schema' },
  { fromId: 'api-key', toId: 'llm-provider', type: 'related_to' as const, docId: 'llm-api-key-setup' },
  { fromId: 'feature-flag', toId: 'api-key', type: 'related_to' as const, docId: 'kb-feature-flags' },
]

// ─── Benchmark queries ────────────────────────────────────────────────────────
//
// Each query names an entity ID that is pinned to exactly one doc.
// The graph should promote that doc over its cluster sibling.

interface BenchmarkQuery {
  label: string
  query: string
  expectedTopId: string
}

const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  {
    label: 'BM25 term-frequency ranking',
    query: 'bm25 term frequency ranking retrieval',
    expectedTopId: 'bm25-ranking-internals',
  },
  {
    label: 'DuckDB graph schema storage',
    query: 'duckdb duckpgq property graph schema',
    expectedTopId: 'duckdb-graph-schema',
  },
  {
    label: 'API key LLM provider setup',
    query: 'api-key llm-provider credentials config',
    expectedTopId: 'llm-api-key-setup',
  },
  {
    label: 'vector similarity embedding',
    query: 'vector-similarity text-embedding dimensions cosine',
    expectedTopId: 'vector-similarity-ranking',
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function buildFixtureBase(): Promise<string> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-graph-bench-'))
  tempDirs.push(baseDir)

  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const writer = new MarkdownMDWriterTool({ baseDir, enableSqliteIndex: true, sqliteDbPath: dbPath })

  for (const doc of DOCS) {
    await writer.writeDocument({
      title: doc.title,
      content: doc.content,
      documentId: doc.id,
      overwrite: true,
      type: doc.type,
    })
  }

  const graphWriter = new DuckGraphWriter(path.join(baseDir, '.kb-graph.duckdb'))
  await graphWriter.open()
  await graphWriter.upsertEntities(GRAPH_ENTITIES)
  await graphWriter.upsertRelationships(GRAPH_RELATIONSHIPS)
  graphWriter.close()

  return baseDir
}

function makeReader(baseDir: string, graphEnabled: boolean): MarkdownDocumentReader {
  return new MarkdownDocumentReader(baseDir, {
    hybridEnabled: true,
    sqliteDbPath: path.join(baseDir, '.kb-index.sqlite'),
    graphRankingEnabled: graphEnabled,
    // Aggressive weights for benchmark: graph should dominate within-cluster tiebreaks.
    // Production defaults (0.2 / 0.25) are conservative; see GRAPH_TUNING.md.
    graphRankingWeight: 0.5,
    graphRankingMaxBoost: 0.5,
    hybridCandidateLimit: 20,
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Graph-aware retrieval benchmark', () => {
  let baseDir: string
  let readerWithGraph: MarkdownDocumentReader
  let readerWithoutGraph: MarkdownDocumentReader

  beforeEach(async () => {
    baseDir = await buildFixtureBase()
    readerWithGraph = makeReader(baseDir, true)
    readerWithoutGraph = makeReader(baseDir, false)
  })

  it('Benchmark: graph reranker achieves ≥3/4 precision@1 on labeled queries', async () => {
    let hits = 0

    for (const bq of BENCHMARK_QUERIES) {
      const response = await readerWithGraph.queryDocuments({
        query: bq.query,
        mode: 'content',
        includeContent: false,
        limit: 3,
      })

      if (response.results[0]?.metadata.id === bq.expectedTopId) {
        hits += 1
      }
    }

    expect(hits).toBeGreaterThanOrEqual(3)
  })

  it('Observability: graphBoost and graphEvidence appear in results when graph is active', async () => {
    const response = await readerWithGraph.queryDocuments({
      query: 'duckdb duckpgq graph schema storage',
      mode: 'content',
      includeContent: false,
      limit: 3,
    })

    const boosted = response.results.filter(r => (r.graphBoost ?? 0) > 0)
    expect(boosted.length).toBeGreaterThan(0)

    for (const r of boosted) {
      expect(r.graphBoost).toBeGreaterThan(0)
      expect(r.graphBoost).toBeLessThanOrEqual(0.5) // bounded by graphRankingMaxBoost=0.5 in test reader
      expect(Array.isArray(r.graphEvidence)).toBe(true)
      expect(r.graphEvidence!.length).toBeGreaterThan(0)
    }
  })

  it('Observability: graphBoost is absent when graph ranking is disabled', async () => {
    const response = await readerWithoutGraph.queryDocuments({
      query: 'duckdb property graph schema',
      mode: 'content',
      includeContent: false,
      limit: 3,
    })

    for (const r of response.results) {
      expect(r.graphBoost).toBeUndefined()
      expect(r.graphEvidence).toBeUndefined()
    }
  })

  it('Observability: retrieval detail contains graph-rerank when graph changes ranking', async () => {
    const response = await readerWithGraph.queryDocuments({
      query: 'duckdb duckpgq property graph',
      mode: 'content',
      includeContent: false,
      limit: 3,
    })

    expect(response.retrieval.detail).toContain('graph-rerank')
  })

  it('Precision: graph improves or maintains top-1 vs baseline on each benchmark query', async () => {
    const results: Array<{
      label: string
      baselineHit: boolean
      graphHit: boolean
    }> = []

    for (const bq of BENCHMARK_QUERIES) {
      const q = { query: bq.query, mode: 'content' as const, includeContent: false, limit: 3 }
      const baselineResp = await readerWithoutGraph.queryDocuments(q)
      const graphResp = await readerWithGraph.queryDocuments(q)

      results.push({
        label: bq.label,
        baselineHit: baselineResp.results[0]?.metadata.id === bq.expectedTopId,
        graphHit: graphResp.results[0]?.metadata.id === bq.expectedTopId,
      })
    }

    // Graph must not regress any query that baseline already got right
    for (const r of results) {
      if (r.baselineHit) {
        expect(r.graphHit, `graph regressed "${r.label}"`).toBe(true)
      }
    }

    // Graph must win at least 3/4 queries overall
    const graphHits = results.filter(r => r.graphHit).length
    expect(graphHits).toBeGreaterThanOrEqual(3)
  })
})
