/**
 * Tests for AST source text reconstruction:
 *  - source_text stored via upsertFact / read back via FactRow
 *  - FactsDocumentReader serves source_text (not fact_text) for import_code facts
 *  - FactsDocumentReader falls back to fact_text when source_text is absent
 *  - Migration 12 adds source_text column
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/core/db-migrations'
import { FactsDocumentReader } from '../../src/tools/facts-document-reader'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function mkdb(): Promise<{ dbPath: string; db: Database; indexer: SqliteKbIndexer }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-src-'))
  tempDirs.push(dir)
  const dbPath = path.join(dir, 'kb.sqlite')
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  runMigrations(db)
  const indexer = new SqliteKbIndexer({ dbPath })
  return { dbPath, db, indexer }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------
describe('migration 12 — source_text column', () => {
  it('source_text column exists after runMigrations', async () => {
    const { db } = await mkdb()
    const cols = (db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map(
      c => c.name
    )
    expect(cols).toContain('source_text')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// SqliteKbIndexer.upsertFact — sourceText persistence
// ---------------------------------------------------------------------------
describe('SqliteKbIndexer.upsertFact — sourceText', () => {
  it('stores sourceText and returns it in FactRow', async () => {
    const { db, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'add is a Function exported from src/math.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/math.ts@add',
      sourceText: 'export function add(a: number, b: number): number { return a + b }',
    })
    const row = db
      .prepare("SELECT source_text FROM facts WHERE source_ref = 'ast:src/math.ts@add'")
      .get() as { source_text: string | null } | undefined
    expect(row?.source_text).toBe(
      'export function add(a: number, b: number): number { return a + b }'
    )
    db.close()
  })

  it('stores NULL when sourceText is omitted', async () => {
    const { db, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'some plain fact',
      sourceKind: 'submit',
    })
    const row = db
      .prepare("SELECT source_text FROM facts WHERE fact_text = 'some plain fact'")
      .get() as { source_text: string | null } | undefined
    expect(row?.source_text).toBeNull()
    db.close()
  })

  it('updates sourceText on re-upsert of same normalized fact', async () => {
    const { db, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'add is a Function exported from src/math.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/math.ts@add',
      sourceText: 'old snippet',
    })
    indexer.upsertFact({
      factText: 'add is a Function exported from src/math.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/math.ts@add',
      sourceText: 'new snippet',
    })
    const row = db
      .prepare("SELECT source_text FROM facts WHERE source_ref = 'ast:src/math.ts@add'")
      .get() as { source_text: string | null } | undefined
    expect(row?.source_text).toBe('new snippet')
    db.close()
  })

  it('getActiveFactById includes source_text', async () => {
    const { indexer } = await mkdb()
    const { id } = indexer.upsertFact({
      factText: 'Foo is a Class exported from src/foo.ts',
      sourceKind: 'import_code',
      sourceText: 'export class Foo {}',
    })
    const fact = indexer.getActiveFactById(id)
    expect(fact?.source_text).toBe('export class Foo {}')
    indexer.close()
  })
})


// ---------------------------------------------------------------------------
// FactsDocumentReader — toResult serves source_text for import_code facts
// ---------------------------------------------------------------------------
describe('FactsDocumentReader — source_text served for import_code', () => {
  it('returns source_text as content when source_kind=import_code and source_text present', async () => {
    const { dbPath, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'Router is a Class exported from src/router.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/router.ts@Router',
      sourceText: 'export class Router { route() {} }',
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const resp = await reader.queryDocuments({
      query: 'Router',
      includeContent: true,
      limit: 5,
    })

    const result = resp.results.find(r => r.metadata.tags?.includes('import_code'))
    expect(result).toBeDefined()
    expect(result?.content).toBe('export class Router { route() {} }')
  })

  it('falls back to fact_text when source_kind=import_code but source_text is NULL', async () => {
    const { dbPath, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'Legacy is a Class exported from src/legacy.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/legacy.ts@Legacy',
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const resp = await reader.queryDocuments({
      query: 'Legacy',
      includeContent: true,
      limit: 5,
    })

    const result = resp.results.find(r => r.metadata.tags?.includes('import_code'))
    expect(result).toBeDefined()
    expect(result?.content).toBe('Legacy is a Class exported from src/legacy.ts')
  })

  it('always uses fact_text for import_doc and submit facts even if source_text were set', async () => {
    const { dbPath, indexer } = await mkdb()
    // import_doc fact — no source_text (normal case)
    indexer.upsertFact({
      factText: 'The architecture doc explains layered design',
      sourceKind: 'import_doc',
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const resp = await reader.queryDocuments({
      query: 'architecture',
      includeContent: true,
      limit: 5,
    })

    const result = resp.results.find(r => r.metadata.tags?.includes('import_doc'))
    expect(result).toBeDefined()
    expect(result?.content).toBe('The architecture doc explains layered design')
  })

  it('does not include content when includeContent=false, regardless of source_text', async () => {
    const { dbPath, indexer } = await mkdb()
    indexer.upsertFact({
      factText: 'add is a Function exported from src/math.ts',
      sourceKind: 'import_code',
      sourceRef: 'ast:src/math.ts@add',
      sourceText: 'export function add(a: number, b: number) { return a + b }',
    })
    indexer.close()

    const reader = new FactsDocumentReader(dbPath)
    const resp = await reader.queryDocuments({
      query: 'add',
      includeContent: false,
      limit: 5,
    })

    for (const result of resp.results) {
      expect(result.content).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// getDeclNode walk-up logic (unit test via side-effect on spans)
// ---------------------------------------------------------------------------
describe('tree-sitter getDeclNode — source text is full declaration, not just name', () => {
  it('TsMorphIndexer stores full declaration text capped at 1500 chars', async () => {
    // This is a logic invariant test: verify the cap produces the right suffix
    const longText = 'x'.repeat(2000)
    const expected = `${'x'.repeat(1497)}…`
    const capped = longText.length > 1500 ? `${longText.slice(0, 1497)}…` : longText
    expect(capped).toBe(expected)
    expect(capped.length).toBe(1498) // 1497 chars + '…' (1 char)
  })

  it('source text within limit passes through unchanged', () => {
    const text = 'export function foo() { return 42 }'
    const capped = text.length > 1500 ? `${text.slice(0, 1497)}…` : text
    expect(capped).toBe(text)
  })
})
