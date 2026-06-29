import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/core/db-migrations'
import { CodeGraphStore } from '../../src/tools/code-graph-store'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'
import { TreeSitterIndexer } from '../../src/tools/tree-sitter-indexer'

let tmpDir: string
let repoRoot: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-ts-indexer-test-'))
  repoRoot = join(tmpDir, 'repo')
  dbPath = join(tmpDir, '.kb-index.sqlite')
  await mkdir(repoRoot, { recursive: true })
  await mkdir(join(repoRoot, 'src'), { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeIndexer() {
  const factIndexer = new SqliteKbIndexer({ dbPath })
  const indexer = new TreeSitterIndexer(dbPath, factIndexer)
  return { indexer, factIndexer }
}

function queryFacts(db: Database, name: string, filePath: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM facts WHERE source_kind='import_code' AND predicate='exported_from' AND subject=? AND object=? AND tombstoned_at IS NULL"
      )
      .get(name, filePath) !== undefined
  )
}

function queryImportFacts(db: Database) {
  return db
    .prepare(
      "SELECT subject, object FROM facts WHERE source_kind='import_code' AND predicate='imports' AND tombstoned_at IS NULL"
    )
    .all() as Array<{ subject: string; object: string }>
}

function queryCodeFileState(db: Database, filePath: string): boolean {
  return db.prepare('SELECT 1 FROM code_file_state WHERE file_path = ?').get(filePath) !== undefined
}

describe('TreeSitterIndexer — Go', () => {
  it('[TC-1] indexes exported functions and types', async () => {
    await writeFile(
      join(repoRoot, 'server.go'),
      'package main\n\nfunc Start() error { return nil }\nfunc internalHelper() {}\ntype Server struct { Host string }\ntype privateStruct struct{}\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.errors).toBe(0)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'Start', 'server.go')).toBe(true)
    expect(queryFacts(db, 'Server', 'server.go')).toBe(true)
    // unexported should not be indexed
    expect(queryFacts(db, 'internalHelper', 'server.go')).toBe(false)
    db.close()
  })

  it('[TC-2] indexes exported methods', async () => {
    await writeFile(
      join(repoRoot, 'handler.go'),
      'package main\n\ntype Handler struct{}\n\nfunc (h *Handler) ServeHTTP() {}\nfunc (h *Handler) internalReset() {}\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.symbols).toBeGreaterThanOrEqual(2)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'ServeHTTP', 'handler.go')).toBe(true)
    expect(queryFacts(db, 'internalReset', 'handler.go')).toBe(false)
    db.close()
  })

  it('[TC-3] indexes exported constants and variables', async () => {
    await writeFile(
      join(repoRoot, 'config.go'),
      'package main\n\nconst MaxRetries = 3\nconst internalTimeout = 5\nvar DefaultAddr = ":8080"\nvar privateKey = "secret"\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'MaxRetries', 'config.go')).toBe(true)
    expect(queryFacts(db, 'DefaultAddr', 'config.go')).toBe(true)
    expect(queryFacts(db, 'internalTimeout', 'config.go')).toBe(false)
    expect(queryFacts(db, 'privateKey', 'config.go')).toBe(false)
    db.close()
  })

  it('[TC-4] emits IMPORTS_FILE edges for resolvable local Go imports', async () => {
    await mkdir(join(repoRoot, 'pkg'), { recursive: true })
    await writeFile(join(repoRoot, 'pkg', 'util.go'), 'package pkg\nfunc Helper() {}')
    await writeFile(join(repoRoot, 'main.go'), 'package main\nimport "./pkg"\nfunc main() {}')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBeGreaterThanOrEqual(1)
    expect(stats.errors).toBe(0)
  })

  it('[TC-5] does not emit IMPORTS_FILE edges for unresolvable Go module paths', async () => {
    await writeFile(
      join(repoRoot, 'main.go'),
      'package main\nimport "github.com/some/external/pkg"\nfunc main() {}'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.edges).toBe(0)
    expect(stats.errors).toBe(0)
  })

  it('[TC-6] skips unchanged files on re-index', async () => {
    await writeFile(join(repoRoot, 'stable.go'), 'package main\nfunc Stable() {}')

    const factIndexer1 = new SqliteKbIndexer({ dbPath })
    const indexer1 = new TreeSitterIndexer(dbPath, factIndexer1)
    const first = await indexer1.indexProject(repoRoot)
    indexer1.close()
    factIndexer1.close()

    const factIndexer2 = new SqliteKbIndexer({ dbPath })
    const indexer2 = new TreeSitterIndexer(dbPath, factIndexer2)
    const second = await indexer2.indexProject(repoRoot)
    indexer2.close()
    factIndexer2.close()

    expect(first.files).toBe(1)
    expect(second.files).toBe(0)
    expect(second.skipped).toBe(1)
  })
})

describe('TreeSitterIndexer — TypeScript', () => {
  it('[TC-7] indexes exported classes and functions', async () => {
    await writeFile(
      join(repoRoot, 'src', 'utils.ts'),
      "export class MyService {}\nexport function compute(x: number): number { return x * 2 }\nexport const VERSION = '1.0'\nfunction privateHelper() {}\n"
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(3)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'MyService', 'src/utils.ts')).toBe(true)
    expect(queryFacts(db, 'compute', 'src/utils.ts')).toBe(true)
    expect(queryFacts(db, 'VERSION', 'src/utils.ts')).toBe(true)
    db.close()
  })

  it('[TC-8] indexes exported interfaces and type aliases', async () => {
    await writeFile(
      join(repoRoot, 'src', 'types.ts'),
      'export interface Config { port: number }\nexport type Handler = (req: unknown) => void\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'Config', 'src/types.ts')).toBe(true)
    expect(queryFacts(db, 'Handler', 'src/types.ts')).toBe(true)
    db.close()
  })

  it('[TC-9] emits IMPORTS_FILE facts for local TS imports', async () => {
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(
      join(repoRoot, 'src', 'b.ts'),
      "import { x } from './a'\nexport const y = x + 1"
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.edges).toBeGreaterThanOrEqual(1)

    const db = new Database(dbPath)
    runMigrations(db)
    const importFacts = queryImportFacts(db)
    db.close()

    expect(importFacts.length).toBeGreaterThanOrEqual(1)
    const edge = importFacts.find(e => e.subject === 'src/b.ts')
    expect(edge?.object).toBe('src/a.ts')
  })

  it('[TC-28] emits EXTENDS and IMPLEMENTS structural facts for classes', async () => {
    await writeFile(
      join(repoRoot, 'src', 'animal.ts'),
      `export interface Animal { speak(): string }
export class Dog extends Pet implements Animal, Comparable { speak() { return 'woof' } }`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    const structural = db
      .prepare(
        "SELECT subject, predicate, object FROM facts WHERE source_kind='import_code' AND predicate IN ('extends','implements') AND tombstoned_at IS NULL"
      )
      .all() as Array<{ subject: string; predicate: string; object: string }>
    db.close()

    expect(structural).toContainEqual({ subject: 'Dog', predicate: 'extends', object: 'Pet' })
    expect(structural).toContainEqual({ subject: 'Dog', predicate: 'implements', object: 'Animal' })
    expect(structural).toContainEqual({
      subject: 'Dog',
      predicate: 'implements',
      object: 'Comparable',
    })
  })

  it('[TC-29] includes the value in fact text for exported constants with literal initializers', async () => {
    await writeFile(
      join(repoRoot, 'src', 'limits.ts'),
      `export const MAX_RETRIES = 5\nexport const VERSION = 'v1.2.3'\nexport const DEBUG = false`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    const texts = (
      db
        .prepare(
          "SELECT fact_text FROM facts WHERE source_kind='import_code' AND predicate='exported_from' AND tombstoned_at IS NULL"
        )
        .all() as Array<{ fact_text: string }>
    ).map(f => f.fact_text)
    db.close()

    expect(texts.some(t => t.includes('MAX_RETRIES') && t.includes('5'))).toBe(true)
    expect(texts.some(t => t.includes('VERSION') && t.includes('v1.2.3'))).toBe(true)
    expect(texts.some(t => t.includes('DEBUG') && t.includes('false'))).toBe(true)
  })

  it('[TC-30] extracts top-level non-exported constants with literal values, skipping complex ones', async () => {
    await writeFile(
      join(repoRoot, 'src', 'config.ts'),
      `const ABSOLUTE_MAX_ITERATIONS = 512
const THRESHOLD = 0.58
const STOP_WORDS = new Set(['the', 'and'])
let MUTABLE = 7
export function getMax() { return ABSOLUTE_MAX_ITERATIONS }`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    const definedTexts = (
      db
        .prepare(
          "SELECT fact_text FROM facts WHERE source_kind='import_code' AND predicate='defined_in' AND tombstoned_at IS NULL"
        )
        .all() as Array<{ fact_text: string }>
    ).map(f => f.fact_text)
    db.close()

    expect(definedTexts.some(t => t.includes('ABSOLUTE_MAX_ITERATIONS') && t.includes('512'))).toBe(
      true
    )
    expect(definedTexts.some(t => t.includes('THRESHOLD') && t.includes('0.58'))).toBe(true)
    // Complex initializers (Set) and `let` declarations are not captured as constants.
    expect(definedTexts.every(t => !t.includes('STOP_WORDS'))).toBe(true)
    expect(definedTexts.every(t => !t.includes('MUTABLE'))).toBe(true)
  })

  it('[TC-31] indexes only the files passed as candidateFiles', async () => {
    await mkdir(join(repoRoot, 'packages', 'catalog', 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const ROOT = true')
    await writeFile(
      join(repoRoot, 'packages', 'catalog', 'src', 'widget.ts'),
      'export class Widget { render() {} }'
    )
    await writeFile(join(repoRoot, 'src', 'ignored.ts'), 'export const SKIP = true')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot, {
      candidateFiles: ['src/index.ts', 'packages/catalog/src/widget.ts'],
    })
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'ROOT', 'src/index.ts')).toBe(true)
    expect(queryFacts(db, 'Widget', 'packages/catalog/src/widget.ts')).toBe(true)
    expect(queryFacts(db, 'SKIP', 'src/ignored.ts')).toBe(false)
    db.close()
  })
})

describe('CodeGraphStore (tree-sitter backed)', () => {
  it('[TC-32] finds exported symbols matching query terms via FTS', async () => {
    await writeFile(join(repoRoot, 'src', 'engine.ts'), 'export class Engine { run() {} }')
    await writeFile(
      join(repoRoot, 'src', 'car.ts'),
      `import { Engine } from './engine'\nexport class Car { constructor(private e: Engine) {} }`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const store = new CodeGraphStore(dbPath)
    const results = store.findCodeSymbolsByName(['engine'], 10)
    store.close()

    expect(results.map(n => n.name)).toContain('Engine')
  })

  it('[TC-33] getSummary returns symbol and file counts', async () => {
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(join(repoRoot, 'src', 'b.ts'), "import { x } from './a'\nexport const y = 2")

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const store = new CodeGraphStore(dbPath)
    const summary = store.getSummary()
    store.close()

    expect(summary.symbols).toBeGreaterThanOrEqual(2)
    expect(summary.files).toBeGreaterThanOrEqual(1)
  })
})

describe('TreeSitterIndexer — TSX', () => {
  it('[TC-10] indexes exported components and functions from .tsx files', async () => {
    await writeFile(
      join(repoRoot, 'src', 'Button.tsx'),
      "import React from './react'\nexport function Button() { return null }\nexport const IconButton = () => null\n"
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'Button', 'src/Button.tsx')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — Python', () => {
  it('[TC-11] indexes functions and classes', async () => {
    await writeFile(
      join(repoRoot, 'app.py'),
      'def public_fn():\n    pass\n\nclass Widget:\n    pass\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'public_fn', 'app.py')).toBe(true)
    expect(queryFacts(db, 'Widget', 'app.py')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — Rust', () => {
  it('[TC-12] indexes functions and structs', async () => {
    await writeFile(join(repoRoot, 'lib.rs'), 'pub fn run() {}\nstruct Engine;\n')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'run', 'lib.rs')).toBe(true)
    expect(queryFacts(db, 'Engine', 'lib.rs')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — HTML', () => {
  it('[TC-13] indexes elements with id attributes', async () => {
    await writeFile(join(repoRoot, 'index.html'), '<html><body><div id="root"></div></body></html>')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryFacts(db, 'root', 'index.html')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — text fallback', () => {
  it('[TC-14] creates a code_file_state entry for non-code files without extracting symbols', async () => {
    await writeFile(join(repoRoot, 'README.md'), '# Hello\nThis is a readme.')
    await writeFile(join(repoRoot, 'config.yaml'), 'key: value\nother: 123')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(0)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryCodeFileState(db, 'README.md')).toBe(true)
    expect(queryCodeFileState(db, 'config.yaml')).toBe(true)
    db.close()
  })

  it('[TC-15] ignores unknown extensions not in the allowlist', async () => {
    await writeFile(join(repoRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(repoRoot, 'go.sum'), 'github.com/foo/bar v1.0.0 h1:abc=')
    await writeFile(join(repoRoot, 'config.yaml'), 'key: value') // .yaml IS in TEXT_EXTS

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    // .png and .sum are not in EXT_MAP or TEXT_EXTS → ignored
    // .yaml is in TEXT_EXTS → gets a code_file_state entry
    expect(stats.files).toBe(1)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryCodeFileState(db, 'image.png')).toBe(false)
    expect(queryCodeFileState(db, 'go.sum')).toBe(false)
    expect(queryCodeFileState(db, 'config.yaml')).toBe(true)
    db.close()
  })

  it('[TC-16] indexes code and text files together in one pass', async () => {
    await writeFile(join(repoRoot, 'main.go'), 'package main\nfunc Run() {}')
    await writeFile(join(repoRoot, 'README.md'), '# docs')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(1) // only Run() from Go
    expect(stats.errors).toBe(0)
  })
})
