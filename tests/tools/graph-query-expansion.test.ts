import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@kb/core/core/db-migrations.js'
import { expandQueryWithGraph, toGraphQuerySlugs } from '@kb/core/tools/graph-query-expansion.js'

describe('graph-query-expansion', () => {
  it('[TC-1] Given a freeform query, then slug extraction produces unigrams and bigrams for graph entity matching', () => {
    const slugs = toGraphQuerySlugs('How does config.json relate to kb graph?')
    expect(slugs).toContain('config')
    expect(slugs).toContain('json')
    expect(slugs).toContain('graph')
    expect(slugs).toContain('config-json')
    expect(slugs).toContain('json-relate')
    expect(slugs.length).toBeLessThanOrEqual(16)
  })

  // ---------------------------------------------------------------------------
  // Tests that require a real SQLite DB
  // ---------------------------------------------------------------------------

  let tmpDir: string
  let db: Database

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-graph-expansion-'))
    const dbPath = path.join(tmpDir, 'kb.sqlite')
    db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('[TC-2] Given facts in DB, then query expansion appends matching subject/object terms', () => {
    db.prepare(
      `INSERT INTO facts (id, fact_text, normalized_text, source_kind, lane_id, confidence, tombstoned_at, created_at, updated_at, subject, predicate, object)
       VALUES ('f1','kb query retrieves via read_facts','kb query retrieves via read_facts','submit','general',0.8,NULL,datetime('now'),datetime('now'),'kb query','retrieves_via','read_facts')`
    ).run()
    db.prepare(
      `INSERT INTO facts (id, fact_text, normalized_text, source_kind, lane_id, confidence, tombstoned_at, created_at, updated_at, subject, predicate, object)
       VALUES ('f2','SQLite stores config','sqlite stores config','submit','general',0.8,NULL,datetime('now'),datetime('now'),'SQLite','stores','config')`
    ).run()

    const expanded = expandQueryWithGraph('config json', db)

    expect(expanded).toContain('config json')
    expect(expanded).toContain('SQLite')
  })

  it('[TC-3] Given a DB with no matching facts, then expansion returns the original query', () => {
    const expanded = expandQueryWithGraph('config json', db)
    expect(expanded).toBe('config json')
  })

  it('[TC-4] Given exported symbols in facts, then expansion appends matching symbol names', () => {
    // Insert an exported_from fact so the FTS expansion picks up 'router'
    db.prepare(
      `INSERT INTO facts (id, fact_text, normalized_text, source_kind, lane_id, confidence, tombstoned_at, created_at, updated_at, subject, predicate, object)
       VALUES ('f-router','router is a Function exported from src/router.ts','router is a function exported from src/router.ts','import_code','general',0.65,NULL,datetime('now'),datetime('now'),'router','exported_from','src/router.ts')`
    ).run()
    db.prepare(
      `INSERT INTO facts_fts (fact_id, fact_text) VALUES ('f-router','router is a Function exported from src/router.ts')`
    ).run()

    const expanded = expandQueryWithGraph('router', db)
    expect(expanded).toContain('router')
  })

  it('[TC-5] Given an empty DB, then expansion falls back gracefully to the original query', () => {
    const expanded = expandQueryWithGraph('some query that matches nothing', db)
    expect(expanded).toBe('some query that matches nothing')
  })
})
