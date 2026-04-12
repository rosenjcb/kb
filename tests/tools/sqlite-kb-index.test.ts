import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
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
  it('Given write_document with sqlite indexing enabled, then should upsert document and chunk records', async () => {
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

    const db = new Database(dbPath, { readonly: true })
    const docCount = db.prepare('SELECT count(*) AS count FROM documents').get() as { count: number }
    const chunkCount = db.prepare('SELECT count(*) AS count FROM chunks').get() as { count: number }
    const embeddingCount = db.prepare('SELECT count(*) AS count FROM chunk_embeddings').get() as { count: number }
    const laneRow = db
      .prepare('SELECT lane FROM documents WHERE id = ?')
      .get('sqlite-index-plan') as { lane: string }

    expect(docCount.count).toBe(1)
    expect(chunkCount.count).toBeGreaterThan(0)
    expect(embeddingCount.count).toBeGreaterThan(0)
    expect(laneRow.lane).toBe('architecture')
    db.close()
  })

  it('Given append/update/prune mutations, then should keep sqlite index synchronized', async () => {
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

    const db = new Database(dbPath, { readonly: true })
    const title = db.prepare('SELECT title FROM documents WHERE id = ?').get('ops-runbook') as { title: string }
    const chunkRows = db
      .prepare('SELECT chunk_text FROM chunks WHERE doc_id = ? ORDER BY chunk_index')
      .all('ops-runbook') as Array<{ chunk_text: string }>

    expect(title.title).toBe('Ops Runbook V2')
    const joined = chunkRows.map(row => row.chunk_text).join('\n')
    expect(joined).toContain('Updated step')
    expect(joined).not.toContain('Deprecated step')
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
      topCandidates: [
        { id: 'ticket-047', score: 0.51 },
      ],
      surface: 'chat',
    })

    indexer.recordRetrievalMissEvent({
      queryFingerprint: 'fp:project-about',
      rawQuery: 'what is this project about',
      stage: 'query_rewrite_retry',
      missReason: 'low_confidence',
      topCandidates: [
        { id: 'ticket-047', score: 0.52 },
      ],
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
      status: idx < 24 ? 'hit' as const : 'miss' as const,
      nextAction: idx < 24 ? 'return' as const : 'advance' as const,
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

    const assessment = indexer.evaluateRetrievalRollout({
      minSampleSize: 20,
      minOverallSuccessRate: 0.7,
      maxOverallMissRate: 0.3,
      maxHybridFallbackRate: 0.25,
    }, 48)

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
      status: idx < 6 ? 'hit' as const : 'miss' as const,
      nextAction: idx < 6 ? 'return' as const : 'advance' as const,
      confidence: idx < 6 ? 0.7 : 0.15,
      method: 'hybrid' as const,
      detail: 'fts+vector-rerank',
      surface: 'reader' as const,
    }))

    indexer.recordRetrievalCheckpointEvents(badEvents)

    const assessment = indexer.evaluateRetrievalRollout({
      minSampleSize: 20,
      minOverallSuccessRate: 0.7,
      maxOverallMissRate: 0.25,
      maxHybridFallbackRate: 0.5,
    }, 48)

    expect(assessment.decision).toBe('rollback')
    expect(assessment.reasons.some(reason => reason.includes('hybrid-fallback-rate-too-high'))).toBe(true)

    indexer.close()
  })

  it('Given legacy rows without lane values, then backfillDocumentLanes should populate document and chunk lanes deterministically', async () => {
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

    const db = new Database(dbPath)
    db.prepare('UPDATE documents SET lane = NULL WHERE id = ?').run('incident-runbook')
    db.prepare('UPDATE chunks SET lane = NULL WHERE doc_id = ?').run('incident-runbook')
    db.close()

    const updated = indexer.backfillDocumentLanes()
    expect(updated).toBeGreaterThan(0)

    const verify = new Database(dbPath, { readonly: true })
    const docLane = verify
      .prepare('SELECT lane FROM documents WHERE id = ?')
      .get('incident-runbook') as { lane: string }
    const chunkLane = verify
      .prepare('SELECT DISTINCT lane FROM chunks WHERE doc_id = ?')
      .all('incident-runbook') as Array<{ lane: string }>
    verify.close()

    expect(docLane.lane).toBe('error-runbook')
    expect(chunkLane.length).toBe(1)
    expect(chunkLane[0].lane).toBe('error-runbook')

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

    const assessment = indexer.evaluateLaneRoutingRollout({
      minSampleSize: 20,
      minLaneSuccessRate: 0.55,
      maxLaneFallbackRate: 0.4,
      maxLowPrecisionLanes: 0,
    }, 48)

    expect(assessment.decision).toBe('rollback')
    expect(assessment.lowPrecisionLanes).toContain('error-runbook')
    expect(assessment.highFallbackLanes).toContain('error-runbook')

    indexer.close()
  })
})