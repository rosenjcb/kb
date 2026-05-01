import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/core/db-migrations'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-migrations-doctype-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('migration v7: doctype redesign legacy remap', () => {
  it('Given documents/derived_docs/original_docs rows with architecture or checklist, then remaps to reference and runbook', () => {
    const dbPath = path.join(tempDir, '.kb-index.sqlite')
    const db = new Database(dbPath)

    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)

    const stampApplied = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    )
    for (let v = 1; v <= 6; v += 1) {
      stampApplied.run(v, `pre-${v}`, new Date().toISOString())
    }

    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        doc_type TEXT
      );
      CREATE TABLE derived_docs (
        id TEXT PRIMARY KEY,
        doc_type TEXT
      );
      CREATE TABLE original_docs (
        id TEXT PRIMARY KEY,
        doc_type TEXT
      );

      INSERT INTO documents     (id, doc_type) VALUES
        ('doc-arch', 'architecture'),
        ('doc-chk',  'checklist'),
        ('doc-ref',  'reference');

      INSERT INTO derived_docs  (id, doc_type) VALUES
        ('der-arch', 'architecture'),
        ('der-chk',  'checklist');

      INSERT INTO original_docs (id, doc_type) VALUES
        ('orig-arch', 'architecture'),
        ('orig-chk',  'checklist'),
        ('orig-run',  'runbook');

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        fact_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        supersedes_fact_id TEXT,
        tombstoned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lane_id TEXT NOT NULL DEFAULT 'general'
      );
    `)

    runMigrations(db)

    const docTypes = (table: string) =>
      Object.fromEntries(
        (
          db.prepare(`SELECT id, doc_type FROM ${table}`).all() as Array<{
            id: string
            doc_type: string | null
          }>
        ).map(row => [row.id, row.doc_type])
      )

    expect(docTypes('documents')).toEqual({
      'doc-arch': 'reference',
      'doc-chk': 'runbook',
      'doc-ref': 'reference',
    })

    expect(docTypes('derived_docs')).toEqual({
      'der-arch': 'reference',
      'der-chk': 'runbook',
    })

    expect(docTypes('original_docs')).toEqual({
      'orig-arch': 'reference',
      'orig-chk': 'runbook',
      'orig-run': 'runbook',
    })

    db.close()
  })

  it('Given a fresh database with no legacy rows, then migration is a no-op and stamp is applied', () => {
    const dbPath = path.join(tempDir, '.kb-index.sqlite')
    const db = new Database(dbPath)

    runMigrations(db)

    const applied = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>

    expect(applied.map(row => row.version)).toContain(7)

    db.close()
  })
})
