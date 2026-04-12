import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    expect(response.retrieval.detail).toBe('latency-budget-exceeded')
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
  })
})
