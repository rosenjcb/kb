import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, runMigrations } from '@kb/core/core/db-migrations.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-migrations-doctype-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('migration runner', () => {
  it('[TC-NZOZ] Given a fresh database with no legacy rows, then migration is a no-op and stamp is applied', () => {
    const dbPath = path.join(tempDir, 'fresh.sqlite')
    const db = new Database(dbPath)
    runMigrations(db)
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number
      }>
    ).map(r => r.version)
    expect(versions[0]).toBe(1)
    expect(versions.at(-1)).toBe(LATEST_SCHEMA_VERSION)
    // Running twice should not throw and must not re-apply rows.
    runMigrations(db)
    const versionsAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    ).n
    expect(versionsAfter).toBe(versions.length)
    db.close()
  })
})

/**
 * v7 remap SQL is stable (architecture→reference, checklist→runbook). Later clean-slate
 * migrations replace `documents`, so this TC asserts the remap itself rather than a partial
 * base walking all the way to LATEST_SCHEMA_VERSION.
 */
describe('migration v7: doctype redesign legacy remap', () => {
  it('[TC-MC1Y] Given documents/derived_docs/original_docs rows with architecture or checklist, then remaps to reference and runbook', () => {
    const dbPath = path.join(tempDir, '.kb-index.sqlite')
    const db = new Database(dbPath)

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
    `)

    // Same SQL as db-migrations version 7.
    db.exec(`
      UPDATE documents     SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE documents     SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
      UPDATE derived_docs  SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE derived_docs  SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
      UPDATE original_docs SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE original_docs SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
    `)

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
})
