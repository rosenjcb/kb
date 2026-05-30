import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownMDWriterTool } from '../../src/tools/markdown-md-writer-tool'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-sqlite-index-'))
  tempDirs.push(dir)
  return dir
}

describe('SQLite KB index integration', () => {
  it('Given write_document with sqlite indexing enabled, then should upsert original_docs record', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'SQLite Index Plan',
      content: 'This is indexed content for hybrid retrieval.',
      tags: ['index', 'sqlite'],
      type: 'reference',
      documentId: 'sqlite-index-plan',
      overwrite: true,
    })

    const db = new Database(dbPath, { readOnly: true })
    const docCount = db.prepare('SELECT count(*) AS count FROM original_docs').get() as {
      count: number
    }
    const row = db
      .prepare('SELECT title, markdown FROM original_docs WHERE id = ?')
      .get('sqlite-index-plan') as { title: string; markdown: string }

    expect(docCount.count).toBe(1)
    expect(row.title).toBe('SQLite Index Plan')
    expect(row.markdown).toContain('hybrid retrieval')
    db.close()
  })

  it('Given append/update/prune mutations, then should keep original_docs markdown synchronized', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Ops Runbook',
      content: ['### Steps', 'Initial step', '', '### Old Section', 'Deprecated step'].join('\n'),
      documentId: 'ops-runbook',
      overwrite: true,
    })

    await writer.appendToDocument({
      documentId: 'ops-runbook',
      content: 'New step appended',
    })

    await writer.updateDocument({
      documentId: 'ops-runbook',
      content: ['### Steps', 'Updated step', '', '### Old Section', 'Deprecated step'].join('\n'),
      title: 'Ops Runbook V2',
    })

    await writer.pruneDocument({
      documentId: 'ops-runbook',
      prunePattern: 'Old Section',
    })

    const db = new Database(dbPath, { readOnly: true })
    const row = db
      .prepare('SELECT title, markdown FROM original_docs WHERE id = ?')
      .get('ops-runbook') as { title: string; markdown: string }

    expect(row.title).toBe('Ops Runbook V2')
    expect(row.markdown).toContain('Updated step')
    expect(row.markdown).not.toContain('Deprecated step')
    db.close()
  })

  it('Given indexed content hash, then should report staleness only when content changes', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    const filePath = path.join(baseDir, 'stale-check.md')
    const content = [
      '# Stale Check',
      '',
      'Created: 2026-04-12T00:00:00.000Z',
      'Tags: test',
      '',
      'Original content',
    ].join('\n')

    expect(indexer.isDocumentStale(filePath, content)).toBe(true)

    indexer.upsertDocumentFromContent(filePath, content)
    expect(indexer.isDocumentStale(filePath, content)).toBe(false)
    expect(indexer.isDocumentStale(filePath, `${content}\nchanged`)).toBe(true)

    indexer.close()
  })

  it('Given repeated miss events with candidates, then should persist miss clusters and accumulate ranking hints', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.recordRetrievalMissEvent({
      queryFingerprint: 'fp:project-about',
      rawQuery: 'what is this project about',
      stage: 'lexical_recovery',
      missReason: 'low_confidence',
      topCandidates: [
        { id: 'ticket-047', score: 0.4 },
        { id: 'general-facts', score: 0.38 },
      ],
      surface: 'reader',
    })

    indexer.recordRetrievalMissEvent({
      queryFingerprint: 'fp:project-about',
      rawQuery: 'what is this project about',
      stage: 'query_rewrite_retry',
      missReason: 'low_confidence',
      topCandidates: [{ id: 'ticket-047', score: 0.51 }],
      surface: 'chat',
    })

    indexer.recordRetrievalMissEvent({
      queryFingerprint: 'fp:project-about',
      rawQuery: 'what is this project about',
      stage: 'query_rewrite_retry',
      missReason: 'low_confidence',
      topCandidates: [{ id: 'ticket-047', score: 0.52 }],
      surface: 'intent-query',
    })

    const clusters = indexer.listRetrievalMissClusters(10)
    const topCluster = clusters[0]
    expect(topCluster.queryFingerprint).toBe('fp:project-about')
    expect(topCluster.missReason).toBe('low_confidence')
    expect(topCluster.occurrences).toBe(3)

    const hints = indexer.getRetrievalRankingHints('fp:project-about', 3)
    expect(hints.length).toBe(1)
    expect(hints[0].docId).toBe('ticket-047')
    expect(hints[0].occurrences).toBe(3)
    expect(hints[0].hintScore).toBeGreaterThan(0.2)

    indexer.close()
  })

  it('Given checkpoint event traces, then should compute stage metrics and promote rollout when thresholds are met', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const events = Array.from({ length: 30 }, (_, idx) => ({
      queryFingerprint: `fp-${idx}`,
      stage: 'hybrid_primary',
      status: idx < 24 ? ('hit' as const) : ('miss' as const),
      nextAction: idx < 24 ? ('return' as const) : ('advance' as const),
      confidence: idx < 24 ? 0.86 : 0.2,
      method: 'hybrid' as const,
      detail: 'fts+vector-rerank',
      surface: 'reader' as const,
    }))

    indexer.recordRetrievalCheckpointEvents(events)

    const metrics = indexer.getRetrievalStageMetrics(48)
    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics[0].stage).toBe('hybrid_primary')
    expect(metrics[0].totalCount).toBe(30)
    expect(metrics[0].hitCount).toBe(24)

    const assessment = indexer.evaluateRetrievalRollout(
      {
        minSampleSize: 20,
        minOverallSuccessRate: 0.7,
        maxOverallMissRate: 0.3,
        maxHybridFallbackRate: 0.25,
      },
      48
    )

    expect(assessment.decision).toBe('promote')
    expect(assessment.sampleSize).toBe(30)
    expect(assessment.reasons).toContain('thresholds-met')

    indexer.close()
  })

  it('Given poor checkpoint outcomes, then rollout assessment should rollback', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const badEvents = Array.from({ length: 20 }, (_, idx) => ({
      queryFingerprint: `bad-fp-${idx}`,
      stage: 'hybrid_primary',
      status: idx < 6 ? ('hit' as const) : ('miss' as const),
      nextAction: idx < 6 ? ('return' as const) : ('advance' as const),
      confidence: idx < 6 ? 0.7 : 0.15,
      method: 'hybrid' as const,
      detail: 'fts+vector-rerank',
      surface: 'reader' as const,
    }))

    indexer.recordRetrievalCheckpointEvents(badEvents)

    const assessment = indexer.evaluateRetrievalRollout(
      {
        minSampleSize: 20,
        minOverallSuccessRate: 0.7,
        maxOverallMissRate: 0.25,
        maxHybridFallbackRate: 0.5,
      },
      48
    )

    expect(assessment.decision).toBe('rollback')
    expect(
      assessment.reasons.some(reason => reason.includes('hybrid-fallback-rate-too-high'))
    ).toBe(true)

    indexer.close()
  })

  it('Given facts-first schema, then backfillDocumentLanes is a no-op', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const filePath = path.join(baseDir, 'incident-runbook.md')
    const content = [
      '# Incident Runbook',
      '',
      'Created: 2026-04-12T00:00:00.000Z',
      'Type: runbook',
      'Tags: ops, incident',
      '',
      'Restart service and verify health checks.',
    ].join('\n')

    indexer.upsertDocumentFromContent(filePath, content)

    const updated = indexer.backfillDocumentLanes()
    expect(updated).toBe(0)

    indexer.close()
  })

  it('Given fact concepts, indexer can search and expand through concept graph', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const factA = indexer.upsertFact({
      factText: 'raylib uses opengl rendering backend',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'opengl backend supports shader pipelines',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })

    const concepts = indexer.listFactConcepts([factA.id])
    expect(concepts.some(c => c.concept_id === 'opengl')).toBe(true)

    const conceptMatches = indexer.searchFactsByConcepts(['opengl'], 10)
    expect(conceptMatches.length).toBeGreaterThan(0)

    const frontierMatches = indexer.searchFactsByConceptFrontier(['raylib', 'opengl'], 10)
    expect(frontierMatches.length).toBeGreaterThan(0)
    expect(frontierMatches[0]?.id).toBe(factA.id)

    const semanticScores = indexer.semanticFactScores('raylib opengl rendering', [
      factA.id,
      frontierMatches[1]?.id ?? '',
    ])
    expect(semanticScores.has(factA.id)).toBe(true)

    const neighbors = indexer.expandNeighborConcepts(['raylib'], 2, 20)
    expect(neighbors).toContain('opengl')

    indexer.close()
  })

  it('Given fact_edges, getFactNeighbors walks both directions and skips seen ids', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const symbolFact = indexer.upsertFact({
      factText: 'TsMorphIndexer is a Class exported from src/tools/code-graph-indexer.ts',
      triplet: {
        subject: 'TsMorphIndexer',
        predicate: 'exported_from',
        object: 'src/tools/code-graph-indexer.ts',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:src/tools/code-graph-indexer.ts@TsMorphIndexer',
      confidence: 0.95,
    })
    const importFact = indexer.upsertFact({
      factText: 'src/cli/init-cli.ts imports src/tools/code-graph-indexer.ts',
      triplet: {
        subject: 'src/cli/init-cli.ts',
        predicate: 'imports',
        object: 'src/tools/code-graph-indexer.ts',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:src/cli/init-cli.ts@import',
      confidence: 0.95,
    })

    expect(indexer.relinkCodeImportEdges()).toBeGreaterThan(0)

    const seen = new Set<string>([importFact.id])
    const neighbors = indexer.getFactNeighbors([importFact.id], seen)
    expect(neighbors.map(row => row.id)).toEqual([symbolFact.id])

    const reverseNeighbors = indexer.getFactNeighbors([symbolFact.id], new Set())
    expect(reverseNeighbors.map(row => row.id)).toEqual(
      expect.arrayContaining([importFact.id])
    )

    indexer.close()
  })

  it('Given natural language query, searchFacts should match token-level evidence', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.upsertFact({
      factText: 'raylib is a C library focused on simple game development workflows',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })
    indexer.upsertFact({
      factText: 'raylib provides rendering, input handling, and audio capabilities',
      sourceKind: 'submit',
      sourceRef: 'test',
      confidence: 0.9,
    })

    const rows = indexer.searchFacts('What is raylib for, and what are its main capabilities?', 5)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(row => row.fact_text.includes('raylib'))).toBe(true)

    indexer.close()
  })

  it('Given lane routing events, then should report lane-level precision and fallback indicators', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.recordLaneRoutingEvent({
      queryFingerprint: 'lane-fp-1',
      primaryLane: 'fact',
      routedLanes: ['fact', 'architecture', 'workflow'],
      routeReason: 'project-overview-signals',
      usedFallback: false,
      status: 'hit',
      nextAction: 'return',
      confidence: 0.82,
      surface: 'reader',
    })

    indexer.recordLaneRoutingEvent({
      queryFingerprint: 'lane-fp-2',
      primaryLane: 'fact',
      routedLanes: ['fact', 'architecture', 'workflow'],
      routeReason: 'default-general-signals',
      usedFallback: true,
      status: 'miss',
      nextAction: 'advance',
      confidence: 0.25,
      surface: 'reader',
    })

    const laneMetrics = indexer.getLaneRoutingMetrics(48)
    expect(laneMetrics.length).toBe(1)
    expect(laneMetrics[0].lane).toBe('fact')
    expect(laneMetrics[0].totalCount).toBe(2)
    expect(laneMetrics[0].hitCount).toBe(1)
    expect(laneMetrics[0].fallbackCount).toBe(1)
    expect(laneMetrics[0].successRate).toBe(0.5)
    expect(laneMetrics[0].fallbackRate).toBe(0.5)

    indexer.close()
  })

  it('Given weak lane-routing metrics, then lane rollout assessment should rollback', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    for (let i = 0; i < 12; i += 1) {
      indexer.recordLaneRoutingEvent({
        queryFingerprint: `lane-bad-${i}`,
        primaryLane: 'error-runbook',
        routedLanes: ['error-runbook', 'fact', 'policy'],
        routeReason: 'operational-signals',
        usedFallback: true,
        status: i < 3 ? 'hit' : 'miss',
        nextAction: i < 3 ? 'return' : 'advance',
        confidence: i < 3 ? 0.75 : 0.2,
        surface: 'reader',
      })
    }

    for (let i = 0; i < 12; i += 1) {
      indexer.recordLaneRoutingEvent({
        queryFingerprint: `lane-good-${i}`,
        primaryLane: 'fact',
        routedLanes: ['fact', 'architecture', 'workflow'],
        routeReason: 'default-general-signals',
        usedFallback: false,
        status: i < 10 ? 'hit' : 'miss',
        nextAction: i < 10 ? 'return' : 'advance',
        confidence: i < 10 ? 0.8 : 0.3,
        surface: 'reader',
      })
    }

    const assessment = indexer.evaluateLaneRoutingRollout(
      {
        minSampleSize: 20,
        minLaneSuccessRate: 0.55,
        maxLaneFallbackRate: 0.4,
        maxLowPrecisionLanes: 0,
      },
      48
    )

    expect(assessment.decision).toBe('rollback')
    expect(assessment.lowPrecisionLanes).toContain('error-runbook')
    expect(assessment.highFallbackLanes).toContain('error-runbook')

    indexer.close()
  })
})

describe('fact category assignment', () => {
  it('listUncategorizedFacts returns only facts with no assignment', async () => {
    const baseDir = await createTempDir()
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })

    const { id: f1 } = indexer.upsertFact({ factText: 'fact one', sourceKind: 'submit' })
    const { id: f2 } = indexer.upsertFact({ factText: 'fact two', sourceKind: 'submit' })

    const category = {
      id: 'category-tui',
      name: 'TUI',
      description: 'TUI facts',
      status: 'accepted' as const,
      createdBy: 'user' as const,
      representativeTerms: ['tui'],
      centroidVector: [],
    }
    indexer.replaceFactCategories([category])
    indexer.replaceFactCategoryAssignments(
      new Map([[f1, [{ categoryId: 'category-tui', score: 0.9 }]]])
    )

    const uncategorized = indexer.listUncategorizedFacts()
    expect(uncategorized.map(f => f.id)).toEqual([f2])
    indexer.close()
  })

  it('mergeFactCategoryAssignments adds new assignments without removing existing ones', async () => {
    const baseDir = await createTempDir()
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })

    const { id: f1 } = indexer.upsertFact({ factText: 'fact one', sourceKind: 'submit' })
    const { id: f2 } = indexer.upsertFact({ factText: 'fact two', sourceKind: 'submit' })

    const categories = [
      { id: 'category-tui', name: 'TUI', description: 'TUI', status: 'accepted' as const, createdBy: 'user' as const, representativeTerms: [], centroidVector: [] },
      { id: 'category-cli', name: 'CLI', description: 'CLI', status: 'accepted' as const, createdBy: 'user' as const, representativeTerms: [], centroidVector: [] },
    ]
    indexer.replaceFactCategories(categories)

    indexer.replaceFactCategoryAssignments(
      new Map([[f1, [{ categoryId: 'category-tui', score: 0.9 }]]])
    )

    // merge assigns f2 without touching f1
    indexer.mergeFactCategoryAssignments(
      new Map([[f2, [{ categoryId: 'category-cli', score: 0.7 }]]])
    )

    expect(indexer.getFactCategoryNames(f1)).toEqual(['TUI'])
    expect(indexer.getFactCategoryNames(f2)).toEqual(['CLI'])
    expect(indexer.countUncategorizedFacts()).toBe(0)
    indexer.close()
  })

  it('mergeFactCategoryAssignments upserts score when fact+category already assigned', async () => {
    const baseDir = await createTempDir()
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })

    const { id: f1 } = indexer.upsertFact({ factText: 'fact one', sourceKind: 'submit' })
    indexer.replaceFactCategories([
      { id: 'category-tui', name: 'TUI', description: 'TUI', status: 'accepted' as const, createdBy: 'user' as const, representativeTerms: [], centroidVector: [] },
    ])
    indexer.replaceFactCategoryAssignments(new Map([[f1, [{ categoryId: 'category-tui', score: 0.5 }]]]))

    // merge with higher score — should update
    indexer.mergeFactCategoryAssignments(new Map([[f1, [{ categoryId: 'category-tui', score: 0.95 }]]]))

    // still just one assignment, score updated
    const names = indexer.getFactCategoryNames(f1)
    expect(names).toEqual(['TUI'])
    expect(indexer.countUncategorizedFacts()).toBe(0)
    indexer.close()
  })
})
