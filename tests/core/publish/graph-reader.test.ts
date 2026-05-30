import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPublishedGraph } from '../../../src/core/publish/graph-reader'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-graph-reader-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const SCHEMA = `
  CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
    source_kind TEXT NOT NULL, source_ref TEXT, confidence REAL NOT NULL DEFAULT 0.8,
    supersedes_fact_id TEXT, tombstoned_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lane_id TEXT NOT NULL DEFAULT 'general',
    subject TEXT NOT NULL DEFAULT '', predicate TEXT NOT NULL DEFAULT '', object TEXT NOT NULL DEFAULT ''
  );
`

function makeDb(baseDir: string, facts: Array<{ subject: string; predicate: string; object: string }>) {
  const db = new Database(path.join(baseDir, '.kb-index.sqlite'))
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO facts (id, fact_text, normalized_text, source_kind, created_at, updated_at, subject, predicate, object)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  facts.forEach((f, i) => {
    insert.run(`fact-${i}`, '', '', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      f.subject, f.predicate, f.object)
  })
  db.close()
}

describe('readPublishedGraph', () => {
  it('returns undefined when no SQLite db exists', async () => {
    expect(await readPublishedGraph(tempDir)).toBeUndefined()
  })

  it('returns empty graph when facts table is empty', async () => {
    makeDb(tempDir, [])
    const result = await readPublishedGraph(tempDir)
    expect(result?.entities).toHaveLength(0)
    expect(result?.relationships).toHaveLength(0)
  })

  it('builds entities from both subjects and objects so all edges are connected', async () => {
    makeDb(tempDir, [
      { subject: 'FuncA', predicate: 'calls', object: 'FuncB' },
      { subject: 'FuncA', predicate: 'exported_from', object: 'src/a.ts' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = new Set(result?.entities.map(e => e.id))
    expect(ids).toContain('FuncA')
    expect(ids).toContain('FuncB')
    expect(ids).toContain('src/a.ts')
    expect(result?.relationships).toHaveLength(2)
  })

  it('excludes tombstoned facts', async () => {
    const db = new Database(path.join(tempDir, '.kb-index.sqlite'))
    db.exec(SCHEMA)
    db.prepare(
      `INSERT INTO facts (id, fact_text, normalized_text, source_kind, created_at, updated_at, tombstoned_at, subject, predicate, object)
       VALUES (?, '', '', 'test', ?, ?, ?, ?, ?, ?)`
    ).run('f0', '2026-01-01', '2026-01-01', '2026-01-02', 'A', 'calls', 'B')
    db.close()

    const result = await readPublishedGraph(tempDir)
    expect(result?.entities).toHaveLength(0)
    expect(result?.relationships).toHaveLength(0)
  })

  it('includes all non-tombstoned facts including kb and asserts predicates', async () => {
    makeDb(tempDir, [
      { subject: 'kb', predicate: 'asserts', object: 'some fact text' },
      { subject: 'FuncA', predicate: 'asserts', object: 'value' },
      { subject: 'FuncA', predicate: 'calls', object: 'FuncB' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = new Set(result?.entities.map(e => e.id))
    expect(ids).toContain('kb')
    expect(ids).toContain('FuncA')
    expect(ids).toContain('FuncB')
    expect(result?.relationships).toHaveLength(3)
  })

  it('includes a generatedAt timestamp', async () => {
    makeDb(tempDir, [])
    const result = await readPublishedGraph(tempDir)
    expect(result?.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
