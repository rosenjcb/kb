import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync as Database } from 'node:sqlite'
import { runMigrations } from '../../src/core/db-migrations'
import { TsMorphIndexer } from '../../src/tools/code-graph-indexer'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'
import { CodeGraphStore } from '../../src/tools/code-graph-store'

let tmpDir: string
let repoRoot: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-code-graph-test-'))
  repoRoot = join(tmpDir, 'repo')
  dbPath = join(tmpDir, '.kb-index.sqlite')
  await mkdir(repoRoot, { recursive: true })
  await mkdir(join(repoRoot, 'src'), { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeTsconfig() {
  await writeFile(
    join(repoRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true },
      include: ['src/**/*'],
    })
  )
}

function makeIndexer() {
  const factIndexer = new SqliteKbIndexer({ dbPath })
  const indexer = new TsMorphIndexer(dbPath, factIndexer)
  return { indexer, factIndexer }
}

describe('TsMorphIndexer', () => {
  it('indexes exported functions and writes symbol facts', async () => {
    await writeTsconfig()
    await writeFile(
      join(repoRoot, 'src', 'utils.ts'),
      `export function add(a: number, b: number): number { return a + b }
export const PI = 3.14`
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    const facts = db
      .prepare(
        "SELECT subject, predicate, object FROM facts WHERE source_kind = 'import_code' AND predicate = 'exported_from' AND tombstoned_at IS NULL"
      )
      .all() as Array<{ subject: string; predicate: string; object: string }>
    db.close()

    const names = facts.map(f => f.subject)
    expect(names).toContain('add')
    expect(names).toContain('PI')
    expect(facts[0]?.object).toMatch(/src\/utils\.ts/)
  })

  it('emits IMPORTS_FILE bridge facts between files', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(join(repoRoot, 'src', 'b.ts'), "import { x } from './a'\nexport const y = x + 1")

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()
    factIndexer.close()

    expect(stats.edges).toBeGreaterThanOrEqual(1)

    const db = new Database(dbPath)
    runMigrations(db)
    const importFacts = db
      .prepare(
        "SELECT subject, predicate, object FROM facts WHERE source_kind = 'import_code' AND predicate = 'imports' AND tombstoned_at IS NULL"
      )
      .all() as Array<{ subject: string; predicate: string; object: string }>
    db.close()

    expect(importFacts.length).toBeGreaterThanOrEqual(1)
    expect(importFacts[0]?.subject).toMatch(/src\/b\.ts/)
    expect(importFacts[0]?.object).toMatch(/src\/a\.ts/)
  })

  it('emits IMPLEMENTS facts for class declarations', async () => {
    await writeTsconfig()
    await writeFile(
      join(repoRoot, 'src', 'animal.ts'),
      `export interface Animal { speak(): string }
export class Dog implements Animal { speak() { return 'woof' } }`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    const implementsFacts = db
      .prepare(
        "SELECT subject, predicate, object FROM facts WHERE source_kind = 'import_code' AND predicate = 'implements' AND tombstoned_at IS NULL"
      )
      .all() as Array<{ subject: string; predicate: string; object: string }>
    db.close()

    expect(implementsFacts.length).toBeGreaterThanOrEqual(1)
    expect(implementsFacts[0]?.subject).toBe('Dog')
    expect(implementsFacts[0]?.object).toBe('Animal')
  })

  it('indexes TS files outside tsconfig include when passed as candidateFiles', async () => {
    // tsconfig only covers src/, but lib/ has TS files we want indexed
    await writeFile(
      join(repoRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'commonjs' },
        include: ['src/**/*'],
      })
    )
    await mkdir(join(repoRoot, 'packages', 'catalog', 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const ROOT = true')
    await writeFile(
      join(repoRoot, 'packages', 'catalog', 'src', 'widget.ts'),
      'export class Widget { render() {} }'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'), {
      candidateFiles: ['src/index.ts', 'packages/catalog/src/widget.ts'],
    })
    indexer.close()
    factIndexer.close()

    // Both files must be indexed even though packages/catalog/src/widget.ts is outside tsconfig include
    expect(stats.files).toBe(2)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    const facts = db
      .prepare(
        "SELECT subject FROM facts WHERE source_kind = 'import_code' AND predicate = 'exported_from' AND tombstoned_at IS NULL"
      )
      .all() as Array<{ subject: string }>
    db.close()

    const names = facts.map(f => f.subject)
    expect(names).toContain('ROOT')
    expect(names).toContain('Widget')
  })

  it('skips unchanged files on re-index', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'stable.ts'), 'export const STABLE = true')

    const factIndexer1 = new SqliteKbIndexer({ dbPath })
    const indexer1 = new TsMorphIndexer(dbPath, factIndexer1)
    const first = await indexer1.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer1.close()
    factIndexer1.close()

    const factIndexer2 = new SqliteKbIndexer({ dbPath })
    const indexer2 = new TsMorphIndexer(dbPath, factIndexer2)
    const second = await indexer2.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer2.close()
    factIndexer2.close()

    expect(first.files).toBe(1)
    expect(second.files).toBe(0)
    expect(second.skipped).toBe(1)
  })
})

describe('CodeGraphStore', () => {
  it('finds exported symbols matching query terms via FTS', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'engine.ts'), 'export class Engine { run() {} }')
    await writeFile(
      join(repoRoot, 'src', 'car.ts'),
      `import { Engine } from './engine'\nexport class Car { constructor(private e: Engine) {} }`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()
    factIndexer.close()

    const store = new CodeGraphStore(dbPath)
    const results = store.findCodeSymbolsByName(['engine'], 10)
    store.close()

    const names = results.map(n => n.name)
    expect(names).toContain('Engine')
  })

  it('getSummary returns correct counts', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(join(repoRoot, 'src', 'b.ts'), "import { x } from './a'\nexport const y = 2")

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()
    factIndexer.close()

    const store = new CodeGraphStore(dbPath)
    const summary = store.getSummary()
    store.close()

    expect(summary.symbols).toBeGreaterThanOrEqual(2)
    expect(summary.files).toBeGreaterThanOrEqual(1)
  })
})
