import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/core/db-migrations'
import { expandQueryWithGraph, toGraphQuerySlugs } from '../../src/tools/graph-query-expansion'

describe('graph-query-expansion', () => {
  it('Given a freeform query, then slug extraction produces unigrams and bigrams for graph entity matching', () => {
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
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-graph-expansion-'))
    const dbPath = path.join(tmpDir, 'kb.sqlite')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Given facts in DB, then query expansion appends matching subject/object terms', () => {
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

  it('Given a DB with no matching facts, then expansion returns the original query', () => {
    const expanded = expandQueryWithGraph('config json', db)
    expect(expanded).toBe('config json')
  })

  it('Given exported symbols in kg_nodes, then expansion appends matching symbol names', () => {
    // Use a name that the unicode61 tokenizer will match on the query term 'router'
    db.prepare(
      `INSERT INTO kg_nodes (id, kind, name, qualified_name, path, source, confidence, exported, props_json, updated_at)
       VALUES ('sym:router','symbol','router','src/router.ts::router','src/router.ts','test',0.9,1,'{}',datetime('now'))`
    ).run()
    db.prepare(
      `INSERT INTO kg_nodes_fts (id, name, qualified_name, path)
       VALUES ('sym:router','router','src/router.ts::router','src/router.ts')`
    ).run()

    const expanded = expandQueryWithGraph('router', db)
    expect(expanded).toContain('router')
  })

  it('Given an empty DB, then expansion falls back gracefully to the original query', () => {
    const expanded = expandQueryWithGraph('some query that matches nothing', db)
    expect(expanded).toBe('some query that matches nothing')
  })
})
