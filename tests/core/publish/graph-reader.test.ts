import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
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
    insert.run(`fact-${i}`, `${f.subject} ${f.predicate} ${f.object}`, '', 'test',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', f.subject, f.predicate, f.object)
  })
  db.close()
}

describe('readPublishedGraph', () => {
  it('returns undefined when no SQLite db exists', async () => {
    const result = await readPublishedGraph(tempDir)
    expect(result).toBeUndefined()
  })

  it('returns empty entities and relationships when facts table is empty', async () => {
    makeDb(tempDir, [])
    const result = await readPublishedGraph(tempDir)
    expect(result).toBeDefined()
    expect(result?.entities).toHaveLength(0)
    expect(result?.relationships).toHaveLength(0)
  })

  it('includes an edge between two concepts that are both subjects', async () => {
    makeDb(tempDir, [
      { subject: 'ConceptA', predicate: 'relates_to', object: 'ConceptB' },
      { subject: 'ConceptB', predicate: 'relates_to', object: 'ConceptA' },
    ])
    const result = await readPublishedGraph(tempDir)
    expect(result).toBeDefined()
    const ids = result?.entities.map(e => e.id)
    expect(ids).toContain('ConceptA')
    expect(ids).toContain('ConceptB')
    expect(result?.relationships).toHaveLength(2)
  })

  it('drops edges whose target is an object-only value (e.g. a file path)', async () => {
    // Both ConceptA and ConceptB are subjects → both in entityIds
    // src/file.ts is only an object → not an entity, edges to it are dropped
    makeDb(tempDir, [
      { subject: 'ConceptA', predicate: 'exported_from', object: 'src/file.ts' },
      { subject: 'ConceptA', predicate: 'relates_to', object: 'ConceptB' },
      { subject: 'ConceptB', predicate: 'exported_from', object: 'src/file.ts' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = result?.entities.map(e => e.id)
    expect(ids).not.toContain('src/file.ts')
    // exported_from edges are dropped (toId = src/file.ts, not a subject)
    // relates_to edge ConceptA→ConceptB survives (both are subjects)
    expect(result?.relationships).toHaveLength(1)
    expect(result?.relationships[0]).toMatchObject({ fromId: 'ConceptA', type: 'relates_to', toId: 'ConceptB' })
  })

  it('keeps a subject-to-subject edge when both are subjects', async () => {
    makeDb(tempDir, [
      { subject: 'A', predicate: 'uses', object: 'B' },
      { subject: 'B', predicate: 'uses', object: 'C' },
      { subject: 'C', predicate: 'uses', object: 'A' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = result?.entities.map(e => e.id)
    expect(ids).toContain('A')
    expect(ids).toContain('B')
    expect(ids).toContain('C')
    // A→B: toId=B is a subject ✓; B→C: toId=C is a subject ✓; C→A: toId=A is a subject ✓
    expect(result?.relationships).toHaveLength(3)
  })

  it('excludes tombstoned facts from entities and relationships', async () => {
    const db = new Database(path.join(tempDir, '.kb-index.sqlite'))
    db.exec(SCHEMA)
    db.prepare(
      `INSERT INTO facts (id, fact_text, normalized_text, source_kind, created_at, updated_at, tombstoned_at, subject, predicate, object)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('fact-0', 'A uses B', '', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z', 'A', 'uses', 'B')
    db.close()

    const result = await readPublishedGraph(tempDir)
    expect(result?.entities).toHaveLength(0)
    expect(result?.relationships).toHaveLength(0)
  })

  it('excludes the kb subject and asserts predicate', async () => {
    // RealNode is the only valid subject; Other is object-only → not in entityIds
    // relates_to edge is dropped because toId=Other is not a subject
    makeDb(tempDir, [
      { subject: 'kb', predicate: 'asserts', object: 'something' },
      { subject: 'RealNode', predicate: 'asserts', object: 'value' },
      { subject: 'RealNode', predicate: 'relates_to', object: 'Other' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = result?.entities.map(e => e.id)
    expect(ids).not.toContain('kb')
    expect(ids).toContain('RealNode')
    expect(result?.relationships).toHaveLength(0)
  })

  it('keeps a cross-concept edge when both ends are subjects', async () => {
    makeDb(tempDir, [
      { subject: 'RealNode', predicate: 'relates_to', object: 'OtherNode' },
      { subject: 'OtherNode', predicate: 'relates_to', object: 'RealNode' },
    ])
    const result = await readPublishedGraph(tempDir)
    const ids = result?.entities.map(e => e.id)
    expect(ids).toContain('RealNode')
    expect(ids).toContain('OtherNode')
    expect(result?.relationships.every(r => r.type !== 'asserts')).toBe(true)
    expect(result?.relationships).toHaveLength(2)
  })

  it('returns all entities without a hard cap', async () => {
    const facts = Array.from({ length: 300 }, (_, i) => ({
      subject: `Node${i}`,
      predicate: 'links',
      object: `Target${i}`,
    }))
    makeDb(tempDir, facts)
    const result = await readPublishedGraph(tempDir)
    expect(result?.entities.length).toBe(300)
  })

  it('includes a generatedAt timestamp', async () => {
    makeDb(tempDir, [])
    const result = await readPublishedGraph(tempDir)
    expect(result?.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
