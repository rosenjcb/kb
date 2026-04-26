import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import dayjs from 'dayjs'
import { toGraphQuerySlugs } from './graph-query-expansion'
import type {
  MarkdownDocumentReader,
  ProbeResult,
  QueryDocumentsInput,
  QueryResponse,
  QueryResult,
} from './markdown-document-reader'
import type { RetrievalLane } from './retrieval-lane-router'

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your',
])

const RESEARCH_MAX_MS = 3000
const COVERAGE_THRESHOLD = 0.6
const MIN_DOCS_TO_ANSWER = 2
const MAX_HYPOTHESES = 12
const QUERY_RESEARCH_MAX_ITERS = parseEnvInt('KB_QUERY_RESEARCH_MAX_ITERS', 3)
const QUERY_RESEARCH_BATCH_SIZE = parseEnvInt('KB_QUERY_RESEARCH_BATCH_SIZE', 3)
const FACET_RECOVERY_MAX_QUERIES = parseEnvInt('KB_QUERY_RESEARCH_FACET_RECOVERY_MAX_QUERIES', 2)

type ExpansionSource =
  | 'original'
  | 'title-pass'
  | 'broad'
  | 'keyword'
  | 'graph-slugs'
  | 'heading-hop'
  | 'coverage-recovery'

interface SearchHypothesis {
  id: string
  parentId?: string
  query: string
  mode: 'content' | 'title'
  lanes?: RetrievalLane[]
  source: ExpansionSource
  depth: number
  probed: boolean
}

interface ResearchScratchpad {
  seenDocIds: Set<string>
  docScores: Map<string, number>
  docTitles: Map<string, string>
  docTags: Map<string, string[]>
  branchDocIds: Map<string, Set<string>>
  docHeadings: Map<string, string[]>
  coverageScore: number
  iterationsRun: number
  startTime: number
}

export class QueryResearchOrchestrator {
  constructor(
    private readonly reader: MarkdownDocumentReader,
    private readonly sqliteDbPath: string,
    private readonly observabilityEnabled: boolean
  ) {}

  async run(input: QueryDocumentsInput): Promise<QueryResponse> {
    const startTime = Date.now()
    const frontier = this.seedHypotheses(input)
    const scratchpad = createScratchpad(startTime)

    for (let iter = 0; iter < QUERY_RESEARCH_MAX_ITERS; iter++) {
      if (Date.now() - startTime > RESEARCH_MAX_MS) break

      scratchpad.iterationsRun++
      const batch = selectFrontier(frontier, QUERY_RESEARCH_BATCH_SIZE)
      if (batch.length === 0) break

      const batchResults = await Promise.all(batch.map(h => this.probeHypothesis(h)))

      for (let i = 0; i < batch.length; i++) {
        batch[i].probed = true
        updateScratchpad(scratchpad, batch[i], batchResults[i])
      }

      computeCoverageScore(scratchpad)

      if (canAnswer(scratchpad)) {
        await this.loadHeadingsForTopDocs(scratchpad)
        await this.runFacetRecovery(input, scratchpad, frontier)
        const response = await this.buildResponse(input, scratchpad)
        this.maybeRecordRun(input, frontier, scratchpad, response, startTime)
        return response
      }

      if (iter < QUERY_RESEARCH_MAX_ITERS - 1 && frontier.length < MAX_HYPOTHESES) {
        const newHypotheses = await this.refineHypotheses(scratchpad, batch, batchResults)
        frontier.push(...newHypotheses)
      }
    }

    const response = await this.exhaustiveFallback(input, scratchpad)
    this.maybeRecordRun(input, frontier, scratchpad, response, startTime)
    return response
  }

  private async runFacetRecovery(
    input: QueryDocumentsInput,
    scratchpad: ResearchScratchpad,
    frontier: SearchHypothesis[]
  ): Promise<void> {
    const query = input.query?.trim()
    if (!query) return

    const recoveryQueries = buildCoverageRecoveryQueries(
      query,
      collectScratchpadEvidenceTokens(scratchpad)
    ).slice(
      0,
      FACET_RECOVERY_MAX_QUERIES
    )
    if (recoveryQueries.length === 0) return

    for (const recoveryQuery of recoveryQueries) {
      if (frontier.length >= MAX_HYPOTHESES) break

      const hypothesis = makeHypothesis({
        query: recoveryQuery,
        mode: 'content',
        lanes: this.reader.resolveLanesForQuery(query),
        source: 'coverage-recovery',
        depth: 1,
      })
      frontier.push(hypothesis)

      const results = await this.probeHypothesis(hypothesis)
      hypothesis.probed = true
      updateScratchpad(scratchpad, hypothesis, results)
    }

    computeCoverageScore(scratchpad)
    await this.loadHeadingsForTopDocs(scratchpad)
  }

  private seedHypotheses(input: QueryDocumentsInput): SearchHypothesis[] {
    const query = input.query?.trim() ?? ''
    const primaryLanes = this.reader.resolveLanesForQuery(query)

    const seeds: SearchHypothesis[] = [
      makeHypothesis({ query, mode: 'content', lanes: primaryLanes, source: 'original', depth: 0 }),
      makeHypothesis({ query, mode: 'title', lanes: undefined, source: 'title-pass', depth: 0 }),
      makeHypothesis({ query, mode: 'content', lanes: undefined, source: 'broad', depth: 0 }),
    ]

    const keywordQuery = buildKeywordQuery(query)
    if (keywordQuery && keywordQuery !== query) {
      seeds.push(
        makeHypothesis({
          query: keywordQuery,
          mode: 'content',
          lanes: primaryLanes,
          source: 'keyword',
          depth: 0,
        })
      )
    }

    const slugs = toGraphQuerySlugs(query)
    const slugQuery = slugs.slice(0, 4).join(' ')
    if (slugQuery && slugQuery !== query && slugQuery !== keywordQuery) {
      seeds.push(
        makeHypothesis({
          query: slugQuery,
          mode: 'content',
          lanes: undefined,
          source: 'graph-slugs',
          depth: 0,
        })
      )
    }

    for (const scopedQuery of buildCoverageRecoveryQueries(query, new Set())) {
      if (scopedQuery && scopedQuery !== query && scopedQuery !== keywordQuery && scopedQuery !== slugQuery) {
        seeds.push(
          makeHypothesis({
            query: scopedQuery,
            mode: 'content',
            lanes: undefined,
            source: 'coverage-recovery',
            depth: 0,
          })
        )
      }
    }

    return seeds
  }

  private async probeHypothesis(h: SearchHypothesis): Promise<ProbeResult[]> {
    if (h.mode === 'title') {
      return this.reader.probeLexical(h.query, h.lanes, 10)
    }
    const hybridResults = await this.reader.probeHybrid(h.query, h.lanes, 10)
    if (hybridResults.length > 0) return hybridResults
    return this.reader.probeLexical(h.query, h.lanes, 10)
  }

  private async refineHypotheses(
    scratchpad: ResearchScratchpad,
    batch: SearchHypothesis[],
    batchResults: ProbeResult[][]
  ): Promise<SearchHypothesis[]> {
    const topDocIds: string[] = []
    for (let i = 0; i < batch.length; i++) {
      const best = batchResults[i][0]
      if (best && best.score > 0.3 && !topDocIds.includes(best.docId)) {
        topDocIds.push(best.docId)
      }
    }
    if (topDocIds.length === 0) return []

    const allHeadings = await Promise.all(
      topDocIds.slice(0, 3).map(id => this.reader.fetchDocHeadings(id))
    )
    for (let i = 0; i < topDocIds.length && i < 3; i++) {
      scratchpad.docHeadings.set(topDocIds[i], allHeadings[i])
    }

    const newTerms = new Set<string>()
    for (const headings of allHeadings) {
      for (const heading of headings) {
        for (const token of heading.toLowerCase().split(/\s+/)) {
          if (token.length > 3 && !STOP_WORDS.has(token)) newTerms.add(token)
        }
      }
    }

    const children: SearchHypothesis[] = []
    const parentId = batch[0]?.id

    const termQuery = [...newTerms].slice(0, 5).join(' ')
    if (termQuery) {
      children.push(
        makeHypothesis({
          query: termQuery,
          mode: 'content',
          lanes: undefined,
          source: 'heading-hop',
          depth: 1,
          parentId,
        })
      )
    }

    const neighbors = await this.reader.expandGraphNeighbors(topDocIds.slice(0, 3))
    if (neighbors.length > 0) {
      const neighborQuery = neighbors.slice(0, 4).join(' ')
      children.push(
        makeHypothesis({
          query: neighborQuery,
          mode: 'content',
          lanes: undefined,
          source: 'heading-hop',
          depth: 1,
          parentId,
        })
      )
    }

    return children.slice(0, 2)
  }

  private async loadHeadingsForTopDocs(scratchpad: ResearchScratchpad): Promise<void> {
    const topDocIds = [...scratchpad.docScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id)

    await Promise.all(
      topDocIds.map(async id => {
        if (!scratchpad.docHeadings.has(id)) {
          scratchpad.docHeadings.set(id, await this.reader.fetchDocHeadings(id))
        }
      })
    )
  }

  private async buildResponse(
    input: QueryDocumentsInput,
    scratchpad: ResearchScratchpad
  ): Promise<QueryResponse> {
    const ranked = [...scratchpad.docScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([docId]) => docId)

    const limit = input.limit ?? 10
    const selected: string[] = []
    for (const docId of ranked) {
      if (selected.length >= limit) break
      const headings = scratchpad.docHeadings.get(docId) ?? []
      let redundant = false
      for (const selId of selected) {
        if (headingOverlap(headings, scratchpad.docHeadings.get(selId) ?? []) > 0.5) {
          redundant = true
          break
        }
      }
      if (!redundant) selected.push(docId)
    }

    const results = await this.fetchResults(selected, input)
    return {
      results,
      total: scratchpad.seenDocIds.size,
      retrieval: {
        method: 'hybrid',
        detail: `research-orchestrator;iterations:${scratchpad.iterationsRun};coverage:${scratchpad.coverageScore.toFixed(2)}`,
      },
    }
  }

  private async exhaustiveFallback(
    input: QueryDocumentsInput,
    scratchpad: ResearchScratchpad
  ): Promise<QueryResponse> {
    const query = input.query?.trim() ?? ''
    const limit = input.limit ?? 10

    const results = await this.reader.probeHybrid(query, undefined, limit)
    if (results.length === 0) {
      const lexical = await this.reader.probeLexical(query, undefined, limit)
      const docIds = lexical.map(r => r.docId)
      const fullResults = await this.fetchResults(docIds, input)
      return {
        results: fullResults,
        total: Math.max(scratchpad.seenDocIds.size, fullResults.length),
        retrieval: {
          method: 'lexical-fallback',
          detail: 'research-orchestrator;exhaustive-fallback',
        },
      }
    }

    const docIds = results.map(r => r.docId)
    const fullResults = await this.fetchResults(docIds, input)
    return {
      results: fullResults,
      total: Math.max(scratchpad.seenDocIds.size, fullResults.length),
      retrieval: { method: 'hybrid', detail: 'research-orchestrator;exhaustive-fallback' },
    }
  }

  private async fetchResults(docIds: string[], input: QueryDocumentsInput): Promise<QueryResult[]> {
    if (docIds.length === 0) return []

    const sqliteResults = new Map<string, QueryResult>()

    try {
      const db = new Database(this.sqliteDbPath, { readonly: true })
      try {
        const getDoc = db.prepare(
          'SELECT id, title, file_path, created_at, updated_at, tags_json, doc_type FROM documents WHERE id = ?'
        )
        const getContent = db.prepare('SELECT content FROM documents WHERE id = ?')

        for (const docId of docIds) {
          const doc = getDoc.get(docId) as
            | {
                id: string
                title: string
                file_path: string
                created_at: string
                updated_at: string
                tags_json?: string
                doc_type?: string
              }
            | undefined
          if (!doc) continue

          let content: string | undefined
          if (input.includeContent) {
            const row = getContent.get(docId) as { content?: string } | undefined
            content = row?.content
          }

          sqliteResults.set(docId, {
            metadata: {
              id: doc.id,
              title: doc.title,
              filePath: doc.file_path,
              createdAt: doc.created_at,
              updatedAt: doc.updated_at,
              tags: parseTagsJson(doc.tags_json),
              type: doc.doc_type as QueryDocumentsInput['type'],
            },
            content,
          })
        }
      } finally {
        db.close()
      }
    } catch {
      // SQLite unavailable — fall through to filesystem
    }

    // For any docIds not resolved from SQLite, try the filesystem
    const baseDir = path.dirname(this.sqliteDbPath)
    const missing = docIds.filter(id => !sqliteResults.has(id))
    await Promise.all(
      missing.map(async docId => {
        try {
          const filePath = path.join(baseDir, `${docId}.md`)
          const raw = await readFile(filePath, 'utf8')
          const lines = raw.split('\n')
          if (!lines[0]?.startsWith('# ')) return
          const title = lines[0].replace(/^# /, '').trim()
          sqliteResults.set(docId, {
            metadata: {
              id: docId,
              title,
              filePath,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            content: input.includeContent ? raw : undefined,
          })
        } catch {
          // file not found — skip
        }
      })
    )

    return docIds.flatMap(id => {
      const result = sqliteResults.get(id)
      return result ? [result] : []
    })
  }

  private maybeRecordRun(
    input: QueryDocumentsInput,
    frontier: SearchHypothesis[],
    scratchpad: ResearchScratchpad,
    response: QueryResponse,
    startTime: number
  ): void {
    if (!this.observabilityEnabled) return
    if (!input.query?.trim()) return

    const query = input.query
    const fingerprint = buildQueryFingerprint(query)
    const now = dayjs().toISOString()
    const runId = randomUUID()
    const elapsedMs = Date.now() - startTime

    const winningBranchId =
      frontier.find(
        h =>
          h.probed &&
          response.results.some(r => scratchpad.branchDocIds.get(h.id)?.has(r.metadata.id))
      )?.id ?? null

    let db: Database.Database | undefined
    try {
      db = new Database(this.sqliteDbPath)
      db.prepare(`
        INSERT INTO retrieval_runs
          (run_id, query_fingerprint, raw_query, total_iterations, hypotheses_count, final_coverage_score, winning_branch_id, surface, elapsed_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        fingerprint,
        query,
        scratchpad.iterationsRun,
        frontier.length,
        scratchpad.coverageScore,
        winningBranchId,
        'reader',
        elapsedMs,
        now
      )

      const insertHyp = db.prepare(`
        INSERT INTO retrieval_hypotheses
          (id, run_id, parent_id, query, mode, lanes_json, source, depth, result_count, best_score, novelty, pruned, prune_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const h of frontier) {
        const branchDocs = scratchpad.branchDocIds.get(h.id)
        const bestScore = branchDocs?.size
          ? Math.max(0, ...[...branchDocs].map(id => scratchpad.docScores.get(id) ?? 0))
          : null
        insertHyp.run(
          h.id,
          runId,
          h.parentId ?? null,
          h.query,
          h.mode,
          h.lanes ? JSON.stringify(h.lanes) : null,
          h.source,
          h.depth,
          branchDocs?.size ?? null,
          bestScore,
          null,
          h.probed ? 0 : 1,
          null,
          now
        )
      }
    } catch {
      // best-effort observability — must not affect serving path
    } finally {
      db?.close()
    }
  }
}

function createScratchpad(startTime: number): ResearchScratchpad {
  return {
    seenDocIds: new Set(),
    docScores: new Map(),
    docTitles: new Map(),
    docTags: new Map(),
    branchDocIds: new Map(),
    docHeadings: new Map(),
    coverageScore: 0,
    iterationsRun: 0,
    startTime,
  }
}

function selectFrontier(frontier: SearchHypothesis[], maxBatch: number): SearchHypothesis[] {
  return frontier
    .filter(h => !h.probed)
    .sort((a, b) => a.depth - b.depth)
    .slice(0, maxBatch)
}

function updateScratchpad(
  scratchpad: ResearchScratchpad,
  h: SearchHypothesis,
  results: ProbeResult[]
): void {
  const branchDocIds = new Set<string>()
  for (const r of results) {
    scratchpad.seenDocIds.add(r.docId)
    branchDocIds.add(r.docId)
    const current = scratchpad.docScores.get(r.docId) ?? 0
    if (r.score > current) {
      scratchpad.docScores.set(r.docId, r.score)
      scratchpad.docTitles.set(r.docId, r.title)
      if (r.tags) scratchpad.docTags.set(r.docId, r.tags)
    }
  }
  scratchpad.branchDocIds.set(h.id, branchDocIds)
}

function computeCoverageScore(scratchpad: ResearchScratchpad): void {
  const { seenDocIds, docScores, branchDocIds } = scratchpad
  if (seenDocIds.size === 0) {
    scratchpad.coverageScore = 0
    return
  }

  const allScores = [...docScores.values()]
  const topScore = allScores.length > 0 ? Math.max(...allScores) : 0

  const docBranchCount = new Map<string, number>()
  for (const branchSet of branchDocIds.values()) {
    for (const docId of branchSet) {
      docBranchCount.set(docId, (docBranchCount.get(docId) ?? 0) + 1)
    }
  }
  const agreedDocs = [...docBranchCount.values()].filter(c => c >= 2).length
  const agreementFraction = seenDocIds.size > 0 ? agreedDocs / seenDocIds.size : 0

  const totalBranchDocs = [...branchDocIds.values()].reduce((sum, s) => sum + s.size, 0)
  const noveltyFraction = totalBranchDocs > 0 ? seenDocIds.size / totalBranchDocs : 0

  scratchpad.coverageScore =
    0.4 * Math.min(1, topScore) + 0.3 * agreementFraction + 0.2 * Math.min(1, noveltyFraction)
}

function canAnswer(scratchpad: ResearchScratchpad): boolean {
  return (
    scratchpad.coverageScore >= COVERAGE_THRESHOLD &&
    scratchpad.seenDocIds.size >= MIN_DOCS_TO_ANSWER
  )
}

function headingOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a.map(h => h.toLowerCase()))
  const setB = new Set(b.map(h => h.toLowerCase()))
  let overlap = 0
  for (const h of setA) {
    if (setB.has(h)) overlap++
  }
  return overlap / Math.max(setA.size, setB.size)
}

function makeHypothesis(params: {
  query: string
  mode: 'content' | 'title'
  lanes?: RetrievalLane[]
  source: ExpansionSource
  depth: number
  parentId?: string
}): SearchHypothesis {
  return {
    id: randomUUID(),
    parentId: params.parentId,
    query: params.query,
    mode: params.mode,
    lanes: params.lanes,
    source: params.source,
    depth: params.depth,
    probed: false,
  }
}

function buildCoverageRecoveryQueries(query: string, evidenceTokens: Set<string>): string[] {
  const queryTokens = tokenizeQueryTerms(query)
  const recoveryQueries: string[] = []
  if (queryTokens.length === 0) return recoveryQueries
  const missingTokens = queryTokens.filter(token => !evidenceTokens.has(token))
  if (missingTokens.length === 0) return recoveryQueries
  const first = missingTokens.slice(0, 4)
  const second = missingTokens.slice(4, 8)
  if (first.length > 0) recoveryQueries.push(first.join(' '))
  if (second.length > 0) recoveryQueries.push(second.join(' '))

  return recoveryQueries
}

function collectScratchpadEvidenceTokens(scratchpad: ResearchScratchpad): Set<string> {
  const tokens = new Set<string>()

  const collect = (value: string): void => {
    const normalized = value.toLowerCase()
    for (const token of normalized.split(/[^a-z0-9]+/)) {
      if (token.length >= 3 && !STOP_WORDS.has(token)) {
        tokens.add(token)
      }
    }
  }

  for (const title of scratchpad.docTitles.values()) {
    collect(title)
  }
  for (const tags of scratchpad.docTags.values()) {
    for (const tag of tags) {
      collect(tag)
    }
  }
  for (const headings of scratchpad.docHeadings.values()) {
    for (const heading of headings) {
      collect(heading)
    }
  }

  return tokens
}

function tokenizeQueryTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 3 && !STOP_WORDS.has(token))
  return [...new Set(normalized)].slice(0, 12)
}

function buildKeywordQuery(query: string): string | undefined {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token))
  if (tokens.length === 0) return undefined
  const ranked = [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, 4)
  if (ranked.length === 0) return undefined
  return ranked.join(' ')
}

function buildQueryFingerprint(query: string): string {
  return createHash('sha256').update(query.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex')
}

function parseTagsJson(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as string[]
    if (!Array.isArray(parsed)) return undefined
    return parsed.filter(tag => typeof tag === 'string')
  } catch {
    return undefined
  }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}
