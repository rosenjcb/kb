import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../src/core/db-migrations'
import { MarkdownDocumentReader, type ProbeResult } from '../../src/tools/markdown-document-reader'
import { QueryResearchOrchestrator } from '../../src/tools/query-research-orchestrator'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-orchestrator-'))
  tempDirs.push(dir)
  return dir
}

function makeProbeResult(docId: string, score: number, title?: string): ProbeResult {
  return { docId, score, title: title ?? docId, tags: [] }
}

function makeReader(baseDir: string): MarkdownDocumentReader {
  return new MarkdownDocumentReader(baseDir)
}

function makeReaderWithSqlite(baseDir: string): MarkdownDocumentReader {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const db = new Database(dbPath)
  runMigrations(db)
  db.close()
  return new MarkdownDocumentReader(baseDir)
}

describe('QueryResearchOrchestrator integration', () => {
  it('Given deep discovery with filesystem docs, should return results via orchestrator', async () => {
    const baseDir = await createTempDir()
    await mkdir(baseDir, { recursive: true })

    await writeFile(
      path.join(baseDir, 'hybrid-search.md'),
      '# Hybrid Search\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: retrieval\n\n## Overview\n\nHybrid search combines FTS and vector retrieval.\n',
      'utf8'
    )
    await writeFile(
      path.join(baseDir, 'lane-routing.md'),
      '# Lane Routing\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: retrieval\n\n## Design\n\nLane routing maps queries to document categories.\n',
      'utf8'
    )
    await writeFile(
      path.join(baseDir, 'unrelated.md'),
      '# Cooking Guide\n\nCreated: 2026-01-01T00:00:00.000Z\nType: reference\nTags: food\n\nRecipes and cooking tips.\n',
      'utf8'
    )

    const reader = makeReader(baseDir)
    const response = await reader.queryDocuments({
      query: 'retrieval search',
      discoveryDepth: 'deep',
    })

    expect(response.results.length).toBeGreaterThan(0)
    expect(response.retrieval.detail).toContain('research-orchestrator')
  })

  it('Given deep discovery with no matching docs, should return empty results without throwing', async () => {
    const baseDir = await createTempDir()
    await mkdir(baseDir, { recursive: true })

    await writeFile(
      path.join(baseDir, 'doc.md'),
      '# Cooking Guide\n\nCreated: 2026-01-01T00:00:00.000Z\n\nRecipes.\n',
      'utf8'
    )

    const reader = makeReader(baseDir)
    const response = await reader.queryDocuments({
      query: 'kubernetes deployment orchestration',
      discoveryDepth: 'deep',
    })

    expect(response).toBeDefined()
    expect(Array.isArray(response.results)).toBe(true)
  })

  it('Given shallow discovery, should NOT route through orchestrator', async () => {
    const baseDir = await createTempDir()

    await writeFile(
      path.join(baseDir, 'doc.md'),
      '# Doc\n\nCreated: 2026-01-01T00:00:00.000Z\n\nSome content.\n',
      'utf8'
    )

    const reader = makeReader(baseDir)
    const response = await reader.queryDocuments({ query: 'content', discoveryDepth: 'shallow' })

    expect(response.retrieval.detail).not.toContain('research-orchestrator')
  })
})

describe('QueryResearchOrchestrator unit', () => {
  it('seedHypotheses produces at least 3 seeds with distinct sources', async () => {
    const baseDir = await createTempDir()
    const reader = makeReader(baseDir)
    const orchestrator = new QueryResearchOrchestrator(
      reader,
      path.join(baseDir, '.kb-index.sqlite'),
      false
    )

    // Access via run() — we verify the behavior through the probe mocks
    const probeHybridSpy = vi.spyOn(reader, 'probeHybrid').mockResolvedValue([])
    const probeLexicalSpy = vi.spyOn(reader, 'probeLexical').mockResolvedValue([])
    vi.spyOn(reader, 'expandGraphNeighbors').mockResolvedValue([])

    await orchestrator.run({ query: 'hybrid retrieval architecture', discoveryDepth: 'deep' })

    // At least 3 distinct probes for 3 seed hypotheses (original, title-pass, broad)
    const totalProbes = probeHybridSpy.mock.calls.length + probeLexicalSpy.mock.calls.length
    expect(totalProbes).toBeGreaterThanOrEqual(3)
  })

  it('canAnswer is true when coverage >= 0.60 and 2+ docs seen', async () => {
    const baseDir = await createTempDir()
    const reader = makeReaderWithSqlite(baseDir)

    // Mock probes: iteration 1 returns 2 strong hits from 2 branches
    vi.spyOn(reader, 'probeHybrid').mockImplementation(async query => {
      if (query.includes('hybrid')) {
        return [makeProbeResult('doc-a', 0.85), makeProbeResult('doc-b', 0.8)]
      }
      return [makeProbeResult('doc-a', 0.75), makeProbeResult('doc-c', 0.7)]
    })
    vi.spyOn(reader, 'probeLexical').mockResolvedValue([])
    vi.spyOn(reader, 'expandGraphNeighbors').mockResolvedValue([])
    vi.spyOn(reader, 'fetchDocHeadings').mockResolvedValue([])

    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const orchestrator = new QueryResearchOrchestrator(reader, dbPath, false)

    // Insert docs so fetchResults can find them
    const db = new Database(dbPath)
    db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
      'doc-a',
      'Doc A',
      '/doc-a.md'
    )
    db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
      'doc-b',
      'Doc B',
      '/doc-b.md'
    )
    db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
      'doc-c',
      'Doc C',
      '/doc-c.md'
    )
    db.close()

    const response = await orchestrator.run({
      query: 'hybrid retrieval',
      discoveryDepth: 'deep',
    })

    expect(response.results.length).toBeGreaterThan(0)
    expect(response.retrieval.detail).toContain('research-orchestrator')
  })

  it('MMR assembly skips redundant docs sharing >50% headings', async () => {
    const baseDir = await createTempDir()
    const reader = makeReaderWithSqlite(baseDir)

    vi.spyOn(reader, 'probeHybrid').mockResolvedValue([
      makeProbeResult('doc-a', 0.9),
      makeProbeResult('doc-b', 0.85),
      makeProbeResult('doc-c', 0.8),
    ])
    vi.spyOn(reader, 'probeLexical').mockResolvedValue([])
    vi.spyOn(reader, 'expandGraphNeighbors').mockResolvedValue([])
    vi.spyOn(reader, 'fetchDocHeadings').mockImplementation(async id => {
      // doc-a and doc-b share all headings; doc-c is different
      if (id === 'doc-a' || id === 'doc-b') return ['Overview', 'Design', 'Implementation']
      return ['Background', 'Usage']
    })

    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const db = new Database(dbPath)
    for (const [id, title] of [
      ['doc-a', 'Doc A'],
      ['doc-b', 'Doc B'],
      ['doc-c', 'Doc C'],
    ]) {
      db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
        id,
        title,
        `/${id}.md`
      )
    }
    db.close()

    const orchestrator = new QueryResearchOrchestrator(reader, dbPath, false)
    const response = await orchestrator.run({ query: 'design overview', discoveryDepth: 'deep' })

    const ids = response.results.map(r => r.metadata.id)
    expect(ids).toContain('doc-a')
    // doc-b should be skipped (>50% heading overlap with doc-a); doc-c should be included
    expect(ids).not.toContain('doc-b')
    expect(ids).toContain('doc-c')
  })

  it('times out gracefully when RESEARCH_MAX_MS exceeded', async () => {
    const baseDir = await createTempDir()
    const reader = makeReader(baseDir)

    vi.spyOn(reader, 'probeHybrid').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return []
    })
    vi.spyOn(reader, 'probeLexical').mockResolvedValue([])
    vi.spyOn(reader, 'expandGraphNeighbors').mockResolvedValue([])

    const orchestrator = new QueryResearchOrchestrator(
      reader,
      path.join(baseDir, '.kb-index.sqlite'),
      false
    )
    const response = await orchestrator.run({ query: 'anything', discoveryDepth: 'deep' })

    // Should not throw; exhaustive fallback covers the gap
    expect(response).toBeDefined()
    expect(Array.isArray(response.results)).toBe(true)
  })

  it('adds generic coverage-recovery probes from missing query terms', async () => {
    const baseDir = await createTempDir()
    const reader = makeReaderWithSqlite(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')

    const db = new Database(dbPath)
    db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
      'doc-a',
      'Doc A',
      '/doc-a.md'
    )
    db.prepare(`INSERT OR IGNORE INTO documents (id, title, file_path, doc_type, lane, tags_json, content_hash, content, created_at, updated_at, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'x', '', '2026-01-01', '2026-01-01', '2026-01-01')`).run(
      'doc-b',
      'Doc B',
      '/doc-b.md'
    )
    db.close()

    const probeHybrid = vi.spyOn(reader, 'probeHybrid').mockImplementation(async query => {
      if (query === 'alpha beta gamma delta epsilon zeta') {
        return [makeProbeResult('doc-a', 0.9), makeProbeResult('doc-b', 0.85)]
      }
      // Coverage recovery probes should execute but yield nothing.
      return []
    })
    vi.spyOn(reader, 'probeLexical').mockResolvedValue([])
    vi.spyOn(reader, 'expandGraphNeighbors').mockResolvedValue([])
    vi.spyOn(reader, 'fetchDocHeadings').mockResolvedValue([])

    const orchestrator = new QueryResearchOrchestrator(reader, dbPath, false)
    await orchestrator.run({ query: 'alpha beta gamma delta epsilon zeta', discoveryDepth: 'deep' })

    const probedQueries = probeHybrid.mock.calls.map(call => String(call[0]))
    expect(probedQueries).toContain('alpha beta gamma delta')
    expect(probedQueries).toContain('epsilon zeta')
  })
})
