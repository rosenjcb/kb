/**
 * Hybrid retrieval over the document / code-symbol index.
 *
 * Three unit types are searched independently — whole markdown `documents`, exported
 * `code_symbols`, and curated `facts` — each through a lexical (FTS5) and a neural
 * (embedding cosine) lane. The six ranked lists are fused with Reciprocal Rank Fusion,
 * then a single hop over `doc_code_links` pulls in the code a top document describes and
 * the documentation that describes a top symbol.
 *
 * There is no graph walk: `doc_code_links` is a flat table and the hop is depth-1 by
 * construction, so retrieval cost is bounded by the candidate pool rather than by how
 * densely the index happens to be connected.
 */

import { isEnvTrue } from '../config/env-boolean.js'
import { formatFactUri, sourceRefToPath } from '../core/fact-uri'
import {
  type CodeSymbolRow,
  DOCUMENT_CONTENT_MAX_CHARS,
  type DocumentIndexRow,
  type FactRow,
  type SqliteKbIndexer,
} from './sqlite-kb-index'

/** Default number of retrieved units handed to synthesis. */
export const DEFAULT_FACT_LIMIT = 40

/** Standard RRF damping constant — high enough that rank 1 does not dominate the fusion. */
const RRF_K = 60

/**
 * Per-kind multiplier applied to a lane's RRF contribution, gated behind `KB_HYBRID_KIND_WEIGHT`
 * (see `resolveFeatureFlags().hybridKindWeight`). Plain rank-position RRF treats a whole
 * markdown document and a single code symbol as equal-weight candidates; symbols are narrower
 * and more often the literal answer to an implementation question, so they get a boost while
 * whole documents — the coarsest unit — get a discount (issue #216).
 */
const KIND_WEIGHT: Record<RetrievedUnitKind, number> = {
  document: 0.9,
  symbol: 1.15,
  fact: 1.0,
}

/** How deep each individual lane searches before fusion. */
const LANE_DEPTH = 40

/** Cap on units pulled in by the one-hop doc↔symbol join. */
const HOP_LIMIT = 8

export type RetrievedUnitKind = 'document' | 'symbol' | 'fact'

export interface RetrievedUnit {
  metadata: {
    id: string
    title: string
    filePath: string
    /** Physical source file this unit came from, when it maps to one. */
    sourcePath?: string
    /** For code symbols, the exported name. */
    symbol?: string
    gitRepo?: string
    createdAt: string
    updatedAt: string
    tags?: string[]
    type?: 'reference'
  }
  content?: string
}

export interface HybridRetrievalOptions {
  query: string
  limit?: number
  includeContent?: boolean
  /** Unit ids the caller has already seen (session exclusions, scope pruning). */
  excludeIds?: Set<string>
}

export interface HybridRetrievalResult {
  units: RetrievedUnit[]
  /** `docs:12,symbols:8,facts:0,hops:4` — surfaced on `retrieval.detail` for --debug. */
  detail: string
  counts: Record<RetrievedUnitKind | 'hops', number>
}

export interface Candidate {
  id: string
  kind: RetrievedUnitKind
  /** Fused score; higher is better. */
  score: number
}

/** Add one ranked lane's reciprocal-rank contribution to the running fusion. */
export function fuseLane(
  fused: Map<string, Candidate>,
  kind: RetrievedUnitKind,
  ids: string[],
  kindWeightEnabled = false
): void {
  const weight = kindWeightEnabled ? KIND_WEIGHT[kind] : 1
  ids.forEach((id, index) => {
    const existing = fused.get(id)
    const contribution = (1 / (RRF_K + index + 1)) * weight
    if (existing) existing.score += contribution
    else fused.set(id, { id, kind, score: contribution })
  })
}

/** Order ids by a score map, best first. Ids without a score are dropped. */
function rankByScore(ids: string[], scores: Map<string, number>): string[] {
  return ids
    .filter(id => scores.has(id))
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`
}

export function documentToUnit(row: DocumentIndexRow, includeContent: boolean): RetrievedUnit {
  const sourcePath = row.git_repo ? `${row.git_repo}/${row.rel_path}` : row.rel_path
  return {
    metadata: {
      id: row.id,
      title: row.title,
      filePath: sourcePath,
      sourcePath,
      ...(row.git_repo ? { gitRepo: row.git_repo } : {}),
      createdAt: row.indexed_at,
      updatedAt: row.indexed_at,
      tags: ['document', ...(row.git_repo ? [row.git_repo] : [])],
      type: 'reference',
    },
    ...(includeContent ? { content: truncate(row.body, DOCUMENT_CONTENT_MAX_CHARS) } : {}),
  }
}

export function codeSymbolToUnit(row: CodeSymbolRow, includeContent: boolean): RetrievedUnit {
  const sourcePath = row.git_repo ? `${row.git_repo}/${row.rel_path}` : row.rel_path
  return {
    metadata: {
      id: row.id,
      title: `${row.name} (${row.kind})`,
      filePath: sourcePath,
      sourcePath,
      symbol: row.name,
      ...(row.git_repo ? { gitRepo: row.git_repo } : {}),
      createdAt: row.indexed_at,
      updatedAt: row.indexed_at,
      tags: ['symbol', row.kind, ...(row.git_repo ? [row.git_repo] : [])],
      type: 'reference',
    },
    ...(includeContent && row.source_text ? { content: row.source_text } : {}),
  }
}

export function factToUnit(row: FactRow, includeContent: boolean): RetrievedUnit {
  const source = sourceRefToPath(row.source_ref, row.git_repo)
  return {
    metadata: {
      id: row.id,
      title: summarizeTitle(row.text),
      filePath: formatFactUri(row.id),
      ...(source ? { sourcePath: source.path } : {}),
      ...(source?.symbol ? { symbol: source.symbol } : {}),
      ...(row.git_repo ? { gitRepo: row.git_repo } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: ['fact', ...(row.git_repo ? [row.git_repo] : [])],
      type: 'reference',
    },
    ...(includeContent ? { content: row.text } : {}),
  }
}

function summarizeTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69)}...`
}

/**
 * Run the hybrid retrieval pass. The caller should have pre-embedded the query with
 * `SqliteKbIndexer.cacheQueryEmbedding` so the neural lanes score against a real vector;
 * without it they fall back to the deterministic hash vector and contribute little, and
 * the lexical lanes carry the result on their own.
 */
export function retrieveHybrid(
  indexer: SqliteKbIndexer,
  options: HybridRetrievalOptions
): HybridRetrievalResult {
  const query = options.query.trim()
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_FACT_LIMIT
  const includeContent = options.includeContent === true
  const exclude = options.excludeIds
  const kindWeightEnabled = isEnvTrue(process.env.KB_HYBRID_KIND_WEIGHT)

  const documents = new Map<string, DocumentIndexRow>()
  const symbols = new Map<string, CodeSymbolRow>()
  const facts = new Map<string, FactRow>()

  if (!query) {
    return { units: [], detail: 'hybrid:empty-query', counts: { document: 0, symbol: 0, fact: 0, hops: 0 } }
  }

  const lexicalDocs = indexer.searchDocumentsFts(query, LANE_DEPTH)
  const lexicalSymbols = indexer.searchCodeSymbolsFts(query, LANE_DEPTH)
  const lexicalFacts = indexer.searchFacts(query, LANE_DEPTH)
  for (const row of lexicalDocs) documents.set(row.id, row)
  for (const row of lexicalSymbols) symbols.set(row.id, row)
  for (const row of lexicalFacts) facts.set(row.id, row)

  const fused = new Map<string, Candidate>()
  fuseLane(fused, 'document', lexicalDocs.map(r => r.id), kindWeightEnabled)
  fuseLane(fused, 'symbol', lexicalSymbols.map(r => r.id), kindWeightEnabled)
  fuseLane(fused, 'fact', lexicalFacts.map(r => r.id), kindWeightEnabled)

  // Neural lanes re-rank the lexical pool rather than scanning every embedding: cosine over
  // the whole index would be a full table scan per query, and a unit no lane surfaced at all
  // is not one RRF would have promoted anyway.
  fuseLane(
    fused,
    'document',
    rankByScore([...documents.keys()], indexer.semanticDocumentScores(query, [...documents.keys()])),
    kindWeightEnabled
  )
  fuseLane(
    fused,
    'symbol',
    rankByScore([...symbols.keys()], indexer.semanticCodeSymbolScores(query, [...symbols.keys()])),
    kindWeightEnabled
  )
  fuseLane(
    fused,
    'fact',
    rankByScore([...facts.keys()], indexer.semanticFactScores(query, [...facts.keys()])),
    kindWeightEnabled
  )

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score)

  // One hop: the code a top document describes, and the docs that describe a top symbol.
  // Hop results enter below every directly-matched unit, so they enrich rather than displace.
  let hops = 0
  const hopFloor = ranked.length > 0 ? (ranked[ranked.length - 1]?.score ?? 0) : 0
  const hopped: Candidate[] = []
  const seedDocs = ranked.filter(c => c.kind === 'document').slice(0, 3)
  const seedSymbols = ranked.filter(c => c.kind === 'symbol').slice(0, 3)

  for (const seed of seedDocs) {
    for (const symbol of indexer.listLinkedSymbols(seed.id, HOP_LIMIT)) {
      if (fused.has(symbol.id)) continue
      symbols.set(symbol.id, symbol)
      hopped.push({ id: symbol.id, kind: 'symbol', score: hopFloor / 2 })
      fused.set(symbol.id, { id: symbol.id, kind: 'symbol', score: hopFloor / 2 })
      hops += 1
    }
  }
  for (const seed of seedSymbols) {
    for (const doc of indexer.listLinkingDocuments(seed.id, HOP_LIMIT)) {
      if (fused.has(doc.id)) continue
      documents.set(doc.id, doc)
      hopped.push({ id: doc.id, kind: 'document', score: hopFloor / 2 })
      fused.set(doc.id, { id: doc.id, kind: 'document', score: hopFloor / 2 })
      hops += 1
    }
  }

  const counts: Record<RetrievedUnitKind | 'hops', number> = {
    document: 0,
    symbol: 0,
    fact: 0,
    hops,
  }
  const units: RetrievedUnit[] = []
  for (const candidate of [...ranked, ...hopped]) {
    if (units.length >= limit) break
    if (exclude?.has(candidate.id)) continue
    let unit: RetrievedUnit | undefined
    if (candidate.kind === 'document') {
      const row = documents.get(candidate.id)
      if (row) unit = documentToUnit(row, includeContent)
    } else if (candidate.kind === 'symbol') {
      const row = symbols.get(candidate.id)
      if (row) unit = codeSymbolToUnit(row, includeContent)
    } else {
      const row = facts.get(candidate.id)
      if (row) unit = factToUnit(row, includeContent)
    }
    if (!unit) continue
    counts[candidate.kind] += 1
    units.push(unit)
  }

  return {
    units,
    detail: `hybrid:docs=${counts.document},symbols=${counts.symbol},facts=${counts.fact},hops=${hops}`,
    counts,
  }
}
