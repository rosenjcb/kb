import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../src/core/db-migrations'
import { promoteAstToSemanticGraph } from '../../src/tools/ast-promote'

let tmpDir: string
let dbPath: string
let db: Database.Database

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-ast-promote-test-'))
  dbPath = join(tmpDir, '.kb-index.sqlite')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  runMigrations(db)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function insertFile(id: string, name: string, relPath: string) {
  db.prepare(
    `INSERT INTO kg_nodes (id, kind, name, qualified_name, path, source, confidence, exported, props_json, updated_at)
     VALUES (?, 'file', ?, ?, ?, 'test', 1.0, 0, '{}', datetime('now'))`
  ).run(id, name, relPath, relPath)
}

function insertSymbol(id: string, name: string, fileId: string, relPath: string, exported = 1) {
  db.prepare(
    `INSERT INTO kg_nodes (id, kind, subkind, name, path, file_id, source, confidence, exported, props_json, updated_at)
     VALUES (?, 'symbol', 'FunctionDeclaration', ?, ?, ?, 'test', 1.0, ?, '{}', datetime('now'))`
  ).run(id, name, relPath, fileId, exported)
}

function insertEdge(id: string, type: string, fromId: string, toId: string) {
  db.prepare(
    `INSERT INTO kg_edges (id, type, from_id, to_id, source, confidence, props_json, updated_at)
     VALUES (?, ?, ?, ?, 'test', 1.0, '{}', datetime('now'))`
  ).run(id, type, fromId, toId)
}

describe('promoteAstToSemanticGraph', () => {
  it('promotes exported symbols as kb_graph_entities', () => {
    insertFile('file:src/utils.ts', 'utils.ts', 'src/utils.ts')
    insertSymbol('symbol:src/utils.ts#add', 'add', 'file:src/utils.ts', 'src/utils.ts')

    const stats = promoteAstToSemanticGraph(db)

    expect(stats.entities).toBeGreaterThanOrEqual(1)
    const entity = db.prepare("SELECT * FROM kb_graph_entities WHERE id = 'add'").get() as
      | { id: string; name: string; type: string }
      | undefined
    expect(entity).not.toBeUndefined()
    expect(entity?.name).toBe('add')
    expect(entity?.type).toBe('system')
  })

  it('does not promote unexported symbols', () => {
    insertFile('file:src/utils.ts', 'utils.ts', 'src/utils.ts')
    insertSymbol('symbol:src/utils.ts#helper', 'helper', 'file:src/utils.ts', 'src/utils.ts', 0)

    promoteAstToSemanticGraph(db)

    const entity = db.prepare("SELECT * FROM kb_graph_entities WHERE id = 'helper'").get()
    expect(entity).toBeUndefined()
  })

  it('promotes file nodes as entities with basename slug as id', () => {
    insertFile('file:src/code-graph-indexer.ts', 'code-graph-indexer.ts', 'src/code-graph-indexer.ts')

    promoteAstToSemanticGraph(db)

    const entity = db.prepare(
      "SELECT * FROM kb_graph_entities WHERE id = 'code-graph-indexer'"
    ).get() as { id: string; name: string } | undefined
    expect(entity).not.toBeUndefined()
    expect(entity?.name).toBe('src/code-graph-indexer.ts')
  })

  it('promotes IMPORTS_FILE edges as imports relationships', () => {
    insertFile('file:src/a.ts', 'a.ts', 'src/a.ts')
    insertFile('file:src/b.ts', 'b.ts', 'src/b.ts')
    insertEdge('e1', 'IMPORTS_FILE', 'file:src/b.ts', 'file:src/a.ts')

    promoteAstToSemanticGraph(db)

    const rel = db.prepare(
      "SELECT * FROM kb_graph_relationships WHERE from_id = 'b' AND to_id = 'a' AND type = 'imports'"
    ).get()
    expect(rel).not.toBeUndefined()
  })

  it('uses weight=0.9 for promoted relationships so LLM-extracted ones rank first', () => {
    insertFile('file:src/a.ts', 'a.ts', 'src/a.ts')
    insertFile('file:src/b.ts', 'b.ts', 'src/b.ts')
    insertEdge('e1', 'IMPORTS_FILE', 'file:src/b.ts', 'file:src/a.ts')

    promoteAstToSemanticGraph(db)

    const rel = db.prepare(
      "SELECT weight FROM kb_graph_relationships WHERE id = 'ast:e1'"
    ).get() as { weight: number } | undefined
    expect(rel?.weight).toBe(0.9)
  })

  it('clears stale ast: relationships on re-run', () => {
    insertFile('file:src/a.ts', 'a.ts', 'src/a.ts')
    insertFile('file:src/b.ts', 'b.ts', 'src/b.ts')
    insertEdge('e1', 'IMPORTS_FILE', 'file:src/b.ts', 'file:src/a.ts')

    promoteAstToSemanticGraph(db)
    const countAfterFirst = (
      db.prepare("SELECT COUNT(*) AS n FROM kb_graph_relationships WHERE id LIKE 'ast:%'").get() as { n: number }
    ).n
    expect(countAfterFirst).toBeGreaterThan(0)

    // Remove the edge then re-promote — stale relationship should be gone
    db.prepare('DELETE FROM kg_edges WHERE id = ?').run('e1')
    promoteAstToSemanticGraph(db)

    const countAfterSecond = (
      db.prepare("SELECT COUNT(*) AS n FROM kb_graph_relationships WHERE id LIKE 'ast:%'").get() as { n: number }
    ).n
    expect(countAfterSecond).toBe(0)
  })

  it('does not overwrite existing LLM-extracted entity with same slug', () => {
    db.prepare(
      "INSERT INTO kb_graph_entities (id, name, type, description, created_at) VALUES ('myclass', 'MyClass', 'concept', 'LLM extracted', datetime('now'))"
    ).run()

    insertFile('file:src/a.ts', 'a.ts', 'src/a.ts')
    insertSymbol('symbol:src/a.ts#MyClass', 'MyClass', 'file:src/a.ts', 'src/a.ts')

    promoteAstToSemanticGraph(db)

    const entity = db.prepare("SELECT * FROM kb_graph_entities WHERE id = 'myclass'").get() as {
      description: string
    }
    // INSERT OR IGNORE preserves the original LLM-extracted row
    expect(entity.description).toBe('LLM extracted')
  })
})
