import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { TsMorphIndexer } from '../../src/tools/code-graph-indexer'
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

describe('TsMorphIndexer', () => {
  it('indexes exported functions and emits file + symbol nodes', async () => {
    await writeTsconfig()
    await writeFile(
      join(repoRoot, 'src', 'utils.ts'),
      `export function add(a: number, b: number): number { return a + b }
export const PI = 3.14`
    )

    const indexer = new TsMorphIndexer(dbPath)
    const stats = indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)
    expect(stats.errors).toBe(0)

    const store = new CodeGraphStore(dbPath)
    const fileNode = store.getNode('file:src/utils.ts')
    expect(fileNode).not.toBeNull()
    expect(fileNode?.kind).toBe('file')

    const addSymbol = store.getNode('symbol:src/utils.ts#add')
    expect(addSymbol).not.toBeNull()
    expect(addSymbol?.subkind).toBe('FunctionDeclaration')
    expect(addSymbol?.exported).toBe(true)
    store.close()
  })

  it('emits IMPORTS_FILE edges between files', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(join(repoRoot, 'src', 'b.ts'), "import { x } from './a'\nexport const y = x + 1")

    const indexer = new TsMorphIndexer(dbPath)
    const stats = indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    expect(stats.edges).toBeGreaterThanOrEqual(1)

    const db = new Database(dbPath)
    const edges = db
      .prepare("SELECT * FROM kg_edges WHERE type = 'IMPORTS_FILE'")
      .all() as Array<{ from_id: string; to_id: string }>
    db.close()

    expect(edges.length).toBeGreaterThanOrEqual(1)
    expect(edges[0]?.from_id).toBe('file:src/b.ts')
    expect(edges[0]?.to_id).toBe('file:src/a.ts')
  })

  it('emits IMPLEMENTS edges for class declarations', async () => {
    await writeTsconfig()
    await writeFile(
      join(repoRoot, 'src', 'animal.ts'),
      `export interface Animal { speak(): string }
export class Dog implements Animal { speak() { return 'woof' } }`
    )

    const indexer = new TsMorphIndexer(dbPath)
    indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    const db = new Database(dbPath)
    const edges = db
      .prepare("SELECT * FROM kg_edges WHERE type = 'IMPLEMENTS'")
      .all() as Array<{ from_id: string; to_id: string }>
    db.close()

    expect(edges.length).toBeGreaterThanOrEqual(1)
    expect(edges[0]?.from_id).toContain('Dog')
    expect(edges[0]?.to_id).toContain('Animal')
  })

  it('skips unchanged files on re-index', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'stable.ts'), 'export const STABLE = true')

    const indexer = new TsMorphIndexer(dbPath)
    const first = indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    const second = indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    expect(first.files).toBe(1)
    expect(second.files).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('populates kg_semantic_bridge when symbol name matches a kb_graph_entity', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'store.ts'), 'export class SqliteStore { get() {} }')

    // Seed a matching semantic entity
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // Run migrations to create tables
    const indexer = new TsMorphIndexer(dbPath)
    // Just open to trigger migrations, then insert entity
    db.prepare(
      `INSERT OR IGNORE INTO kb_graph_entities (id, name, type, created_at) VALUES ('sqlite-store', 'SqliteStore', 'system', datetime('now'))`
    ).run()

    indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    const bridge = db
      .prepare("SELECT * FROM kg_semantic_bridge WHERE semantic_entity_id = 'sqlite-store'")
      .all() as Array<{ code_node_id: string }>
    db.close()

    expect(bridge.length).toBe(1)
    expect(bridge[0]?.code_node_id).toBe('symbol:src/store.ts#SqliteStore')
  })
})

describe('CodeGraphStore.expandWithCodeNeighbors', () => {
  it('returns code neighbors of semantic entity ids via bridge', async () => {
    await writeTsconfig()
    await writeFile(join(repoRoot, 'src', 'engine.ts'), 'export class Engine { run() {} }')
    await writeFile(
      join(repoRoot, 'src', 'car.ts'),
      `import { Engine } from './engine'\nexport class Car { constructor(private e: Engine) {} }`
    )

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    const indexer = new TsMorphIndexer(dbPath)
    db.prepare(
      `INSERT OR IGNORE INTO kb_graph_entities (id, name, type, created_at) VALUES ('engine', 'Engine', 'system', datetime('now'))`
    ).run()
    indexer.indexProject(repoRoot, join(repoRoot, 'tsconfig.json'))
    indexer.close()

    const store = new CodeGraphStore(dbPath)
    const neighbors = store.expandWithCodeNeighbors(['engine'])
    store.close()
    db.close()

    const names = neighbors.map(n => n.name)
    expect(names).toContain('Car')
  })
})
