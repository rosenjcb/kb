import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownDocumentReader } from '../../src/tools/markdown-document-reader'
import { MarkdownMDWriterTool } from '../../src/tools/markdown-md-writer-tool'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-reader-'))
  tempDirs.push(dir)
  return dir
}

describe('MarkdownDocumentReader', () => {
  it('Given type filter, then should only return matching document types', async () => {
    const baseDir = await createTempDir()
    await mkdir(baseDir, { recursive: true })

    await writeFile(
      path.join(baseDir, 'arch.md'),
      '# Architecture Doc\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: system\n\nBody\n',
      'utf8'
    )

    await writeFile(
      path.join(baseDir, 'runbook.md'),
      '# Runbook Doc\n\nCreated: 2026-01-01T00:00:00.000Z\nType: runbook\nTags: ops\n\nBody\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir)
    const response = await reader.queryDocuments({ type: 'architecture' })

    expect(response.total).toBe(1)
    expect(response.retrieval.method).toBe('lexical')
    expect(response.results[0]?.metadata.id).toBe('arch')
    expect(response.results[0]?.metadata.type).toBe('architecture')
  })

  it('Given query + type filter, then should apply both constraints', async () => {
    const baseDir = await createTempDir()

    await writeFile(
      path.join(baseDir, 'decision-1.md'),
      '# Auth Decision\n\nCreated: 2026-01-01T00:00:00.000Z\nType: decision\n\nBody\n',
      'utf8'
    )

    await writeFile(
      path.join(baseDir, 'reference-1.md'),
      '# Auth Reference\n\nCreated: 2026-01-01T00:00:00.000Z\nType: reference\n\nBody\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir)
    const response = await reader.queryDocuments({
      query: 'auth',
      mode: 'title',
      type: 'decision',
    })

    expect(response.total).toBe(1)
    expect(response.results[0]?.metadata.id).toBe('decision-1')
  })

    it('Given natural-language question, when querying content mode, then matches by token overlap', async () => {
      const baseDir = await createTempDir()
      await writeFile(path.join(baseDir, 'future-plan.md'), `# Storage Direction\n\nCreated: 2026-01-01\nType: reference\n\nThe current persistent store is markdown files. SQLite is a potential future backend direction.\n`)

      const reader = new MarkdownDocumentReader(baseDir)
      const response = await reader.queryDocuments({
        query: 'What is the future plan for our document store?',
        mode: 'content',
        includeContent: true,
      })

      expect(response.total).toBe(1)
      expect(response.results[0]?.metadata.id).toBe('future-plan')
    })

  it('Given hybrid query enabled with SQLite index, then should rank and return indexed documents', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Vector Search Notes',
      content: 'Hybrid retrieval combines FTS and vector reranking for semantic matches.',
      documentId: 'vector-search-notes',
      overwrite: true,
      type: 'reference',
    })

    await writer.writeDocument({
      title: 'Unrelated Topic',
      content: 'This document discusses gardening and compost only.',
      documentId: 'unrelated-topic',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      hybridCandidateLimit: 20,
    })

    const response = await reader.queryDocuments({
      query: 'semantic vector reranking retrieval',
      mode: 'content',
      includeContent: true,
      limit: 5,
    })

    expect(response.total).toBeGreaterThan(0)
    expect(response.retrieval.method).toBe('hybrid')
    expect(response.results[0]?.metadata.id).toBe('vector-search-notes')
  })

  it('Given hybrid enabled but missing SQLite index, then should fallback to lexical search', async () => {
    const baseDir = await createTempDir()
    await writeFile(
      path.join(baseDir, 'fallback-doc.md'),
      '# Fallback Doc\n\nCreated: 2026-01-01\nType: reference\n\nLexical fallback should still find this content.\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: path.join(baseDir, 'missing.sqlite'),
    })

    const response = await reader.queryDocuments({
      query: 'fallback find this content',
      mode: 'content',
      includeContent: true,
    })

    expect(response.total).toBe(1)
    expect(response.retrieval.method).toBe('lexical-fallback')
    expect(response.results[0]?.metadata.id).toBe('fallback-doc')
    expect(response.retrieval.checkpoints?.map(c => c.stage)).toEqual([
      'hybrid_primary',
      'lexical_recovery',
    ])
    expect(response.retrieval.checkpoints?.[0]?.nextAction).toBe('advance')
    expect(response.retrieval.checkpoints?.[1]?.nextAction).toBe('return')
  })

  it('Given very small hybrid latency budget, then should fallback to lexical path', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Latency Guardrail',
      content: 'Hybrid query latency budget fallback validation content.',
      documentId: 'latency-guardrail',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      hybridMaxMs: 0,
    })

    const response = await reader.queryDocuments({
      query: 'latency budget fallback validation',
      mode: 'content',
      includeContent: true,
    })

    expect(response.total).toBe(1)
    expect(response.retrieval.method).toBe('lexical-fallback')
    expect(response.retrieval.detail).toContain('latency-budget-exceeded')
    expect(response.results[0]?.metadata.id).toBe('latency-guardrail')
  })

  it('Given multiple lexical matches, then should rank strongest document first instead of stopping early', async () => {
    const baseDir = await createTempDir()

    await writeFile(
      path.join(baseDir, 'weak-match.md'),
      '# Weak Match\n\nCreated: 2026-01-01\nType: reference\n\nThis mentions retrieval once.\n',
      'utf8'
    )

    await writeFile(
      path.join(baseDir, 'strong-match.md'),
      '# Strong Match\n\nCreated: 2026-01-02\nType: reference\n\nHybrid retrieval uses sqlite fts and vector rerank retrieval behavior for query quality.\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir)
    const response = await reader.queryDocuments({
      query: 'hybrid retrieval sqlite vector rerank behavior',
      mode: 'content',
      includeContent: true,
      limit: 1,
    })

    expect(response.total).toBe(2)
    expect(response.results[0]?.metadata.id).toBe('strong-match')
  })

  it('Given natural-language query with no direct phrase match, then keyword broadening should recover relevant content', async () => {
    const baseDir = await createTempDir()

    await writeFile(
      path.join(baseDir, 'project-overview.md'),
      '# Project Overview\n\nCreated: 2026-01-01\nType: reference\n\nThis repository is a local knowledge-base agent harness for intent-first CLI workflows and document tooling.\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: false,
    })

    const response = await reader.queryDocuments({
      query: 'What is this project about and what does this system do overall?',
      mode: 'content',
      includeContent: true,
      limit: 5,
    })

    expect(response.total).toBe(1)
    expect(response.results[0]?.metadata.id).toBe('project-overview')
    expect(response.retrieval.method).toBe('lexical')
    expect(response.retrieval.detail).toContain('hybrid-not-attempted')
    const stages = response.retrieval.checkpoints?.map(c => c.stage) ?? []
    expect(stages[0]).toBe('lexical_recovery')
    expect(['lexical_recovery', 'query_rewrite_retry']).toContain(stages.at(-1))
    expect(response.retrieval.checkpoints?.at(-1)?.nextAction).toBe('return')
  })

  it('Given miss-learning enabled and no results, then should persist miss event in sqlite schema', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')

    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Known Doc',
      content: 'This document is about release checklists.',
      documentId: 'known-doc',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: false,
      missLearningEnabled: true,
      sqliteDbPath: dbPath,
    })

    const response = await reader.queryDocuments({
      query: 'zxqv unmatched gibberish topic',
      mode: 'content',
      includeContent: true,
      limit: 5,
    })

    expect(response.total).toBe(0)

    const db = new Database(dbPath, { readonly: true })
    const missRows = db
      .prepare('SELECT miss_reason AS missReason FROM retrieval_miss_events')
      .all() as Array<{ missReason: string }>
    db.close()

    expect(missRows.length).toBe(1)
    expect(missRows[0].missReason).toBe('no_candidates')
  })

  it('Given miss-learning disabled and no results, then should not persist miss events', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')

    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Known Doc',
      content: 'This document is about release checklists.',
      documentId: 'known-doc',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: false,
      missLearningEnabled: false,
      sqliteDbPath: dbPath,
    })

    const response = await reader.queryDocuments({
      query: 'zxqv unmatched gibberish topic',
      mode: 'content',
      includeContent: true,
      limit: 5,
    })

    expect(response.total).toBe(0)

    const db = new Database(dbPath, { readonly: true })
    const missCount = db
      .prepare('SELECT count(*) AS count FROM retrieval_miss_events')
      .get() as { count: number }
    db.close()

    expect(missCount.count).toBe(0)
  })

  it('Given checkpoint-enabled query, then should persist stage events for observability metrics', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')

    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Hybrid Retrieval Notes',
      content: 'Hybrid retrieval combines lexical and vector ranking.',
      documentId: 'hybrid-notes',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      checkpointObservabilityEnabled: true,
    })

    const response = await reader.queryDocuments({
      query: 'hybrid lexical vector ranking',
      mode: 'content',
      includeContent: true,
      limit: 5,
    })

    expect(response.total).toBeGreaterThan(0)

    const db = new Database(dbPath, { readonly: true })
    const checkpointCount = db
      .prepare('SELECT count(*) AS count FROM retrieval_checkpoint_events')
      .get() as { count: number }
    db.close()

    expect(checkpointCount.count).toBeGreaterThan(0)
  })

  it('Given broad project and operational queries, then lane routing should choose different lane sets', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Project Overview',
      content: 'This project is an intent-first knowledge base CLI with retrieval tooling.',
      documentId: 'project-overview',
      overwrite: true,
      type: 'reference',
    })

    await writer.writeDocument({
      title: 'Incident Runbook',
      content: 'When production error spikes, restart the service and check logs.',
      documentId: 'incident-runbook',
      overwrite: true,
      type: 'runbook',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: true,
    })

    const broad = await reader.queryDocuments({
      query: 'what is this project about overall',
      mode: 'content',
      limit: 5,
    })

    const operational = await reader.queryDocuments({
      query: 'how do we handle a production incident error quickly',
      mode: 'content',
      limit: 5,
    })

    expect(broad.retrieval.laneRouting?.lanes).toEqual(['fact', 'architecture', 'workflow'])
    expect(operational.retrieval.laneRouting?.lanes).toEqual(['error-runbook', 'fact', 'policy'])
  })

  it('Given mixed-lane corpus, lane routing should improve top-result precision over mixed baseline fixture', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Session Log Retrieval Notes',
      content: 'Today we discussed what this project is about in a noisy transcript with repeated chatter.',
      documentId: 'session-log-2026-04-12',
      overwrite: true,
      type: 'reference',
    })

    await writer.writeDocument({
      title: 'General Facts',
      content: 'This project provides an intent-first CLI for a markdown-backed knowledge base.',
      documentId: 'general-facts',
      overwrite: true,
      type: 'reference',
    })

    const mixedReader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: false,
    })

    const laneReader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: true,
    })

    const query = 'what is this project about'
    const mixed = await mixedReader.queryDocuments({ query, mode: 'content', limit: 1 })
    const routed = await laneReader.queryDocuments({ query, mode: 'content', limit: 1 })

    expect(mixed.total).toBeGreaterThan(0)
    expect(routed.total).toBeGreaterThan(0)
    expect(routed.results[0]?.metadata.id).toBe('general-facts')
    expect(routed.retrieval.laneRouting?.lanes).toEqual(['fact', 'architecture', 'workflow'])
  })

  it('Given structured docs and session logs, default query should prefer structured lanes and exclude session logs initially', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'General Facts',
      content: 'KB CLI supports query, submit, validate, dispute, explain, and chat commands.',
      documentId: 'general-facts',
      overwrite: true,
      type: 'reference',
    })

    await writer.writeDocument({
      title: 'Session Log - April 12',
      content: 'Random session chatter and temporary notes not meant for primary retrieval.',
      documentId: 'session-log-2026-04-12',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: true,
    })

    const response = await reader.queryDocuments({
      query: 'how do i use the kb cli commands',
      mode: 'content',
      limit: 3,
    })

    expect(response.total).toBeGreaterThan(0)
    expect(response.results[0]?.metadata.id).toBe('general-facts')
    expect(response.retrieval.detail ?? '').not.toContain('session-log-last-resort')
    expect(response.retrieval.laneRouting?.lanes).toEqual(['fact', 'architecture', 'workflow'])
  })

  it('Given only session logs, default query should use session-log lane as last resort fallback', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Session Log - April 12',
      content: 'This temporary note contains ad hoc discussion about CLI usage.',
      documentId: 'session-log-2026-04-12',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: true,
    })

    const response = await reader.queryDocuments({
      query: 'how do i use kb cli commands',
      mode: 'content',
      limit: 3,
    })

    expect(response.total).toBe(1)
    expect(response.results[0]?.metadata.id).toBe('session-log-2026-04-12')
    expect(response.retrieval.detail ?? '').toContain('session-log-last-resort')
    expect(response.retrieval.laneRouting?.usedFallback).toBe(true)
    expect(response.retrieval.laneRouting?.lanes).toEqual(['session-log'])
  })

  it('Given explicit change-diff query, lane router should target session logs directly', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const writer = new MarkdownMDWriterTool({
      baseDir,
      enableSqliteIndex: true,
      sqliteDbPath: dbPath,
    })

    await writer.writeDocument({
      title: 'Session Log - April 12',
      content: 'Change diff: retrieval lane routing was introduced today.',
      documentId: 'session-log-2026-04-12',
      overwrite: true,
      type: 'reference',
    })

    const reader = new MarkdownDocumentReader(baseDir, {
      hybridEnabled: true,
      sqliteDbPath: dbPath,
      laneRoutingEnabled: true,
    })

    const response = await reader.queryDocuments({
      query: 'what changed today show me change diff',
      mode: 'content',
      limit: 3,
    })

    expect(response.total).toBe(1)
    expect(response.retrieval.laneRouting?.lanes).toEqual(['session-log', 'workflow', 'fact'])
    expect(response.retrieval.detail ?? '').toContain('lane-router:change-diff-signals')
  })
})
