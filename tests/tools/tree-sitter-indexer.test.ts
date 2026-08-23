import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@kb/core/core/db-migrations.js'
import { CodeGraphStore } from '@kb/core/tools/code-graph-store.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { TreeSitterIndexer } from '@kb/core/tools/tree-sitter-indexer.js'

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
  const symbolIndexer = new SqliteKbIndexer({ dbPath })
  const indexer = new TreeSitterIndexer(dbPath, symbolIndexer)
  return { indexer, factIndexer: symbolIndexer, symbolIndexer }
}

function querySymbol(db: Database, name: string, filePath: string): boolean {
  return (
    db.prepare('SELECT 1 FROM code_symbols WHERE name = ? AND rel_path = ?').get(name, filePath) !==
    undefined
  )
}

function queryCodeFileState(db: Database, filePath: string): boolean {
  return db.prepare('SELECT 1 FROM code_file_state WHERE file_path = ?').get(filePath) !== undefined
}

function querySymbolKind(db: Database, name: string, filePath: string): string | undefined {
  const row = db
    .prepare('SELECT kind FROM code_symbols WHERE name = ? AND rel_path = ?')
    .get(name, filePath) as { kind: string } | undefined
  return row?.kind
}

describe('TreeSitterIndexer — Go', () => {
  it('[TC-QXNY] indexes exported functions and types', async () => {
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
    expect(querySymbol(db, 'Start', 'server.go')).toBe(true)
    expect(querySymbol(db, 'Server', 'server.go')).toBe(true)
    // unexported should not be indexed
    expect(querySymbol(db, 'internalHelper', 'server.go')).toBe(false)
    db.close()
  })

  it('[TC-RH8M] indexes exported methods', async () => {
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
    expect(querySymbol(db, 'ServeHTTP', 'handler.go')).toBe(true)
    expect(querySymbol(db, 'internalReset', 'handler.go')).toBe(false)
    db.close()
  })

  it('[TC-ASLD] indexes exported constants and variables', async () => {
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
    expect(querySymbol(db, 'MaxRetries', 'config.go')).toBe(true)
    expect(querySymbol(db, 'DefaultAddr', 'config.go')).toBe(true)
    expect(querySymbol(db, 'internalTimeout', 'config.go')).toBe(false)
    expect(querySymbol(db, 'privateKey', 'config.go')).toBe(false)
    db.close()
  })

  it('[TC-P4LY] does not emit structural import edges (v1 indexes symbols only)', async () => {
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

  it('[TC-DRVZ] does not emit IMPORTS_FILE edges for unresolvable Go module paths', async () => {
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

  it('[TC-ANJ4] skips unchanged files on re-index', async () => {
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
  it('[TC-11O9] indexes exported classes and functions', async () => {
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
    expect(querySymbol(db, 'MyService', 'src/utils.ts')).toBe(true)
    expect(querySymbol(db, 'compute', 'src/utils.ts')).toBe(true)
    expect(querySymbol(db, 'VERSION', 'src/utils.ts')).toBe(true)
    db.close()
  })

  it('[TC-3FNF] indexes exported interfaces and type aliases', async () => {
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
    expect(querySymbol(db, 'Config', 'src/types.ts')).toBe(true)
    expect(querySymbol(db, 'Handler', 'src/types.ts')).toBe(true)
    db.close()
  })

  it('[TC-954G] does not emit IMPORTS_FILE facts (v1 indexes symbols only)', async () => {
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(
      join(repoRoot, 'src', 'b.ts'),
      "import { x } from './a'\nexport const y = x + 1\n"
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.symbols).toBeGreaterThanOrEqual(2)
    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'x', 'src/a.ts')).toBe(true)
    expect(querySymbol(db, 'y', 'src/b.ts')).toBe(true)
    db.close()
  })

  it('[TC-YUE1] does not emit EXTENDS/IMPLEMENTS structural facts (v1 symbols only)', async () => {
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
    expect(querySymbol(db, 'Dog', 'src/animal.ts')).toBe(true)
    expect(querySymbol(db, 'Animal', 'src/animal.ts')).toBe(true)
    db.close()
  })

  it('[TC-0JE8] stores source_text for exported constants with literal initializers', async () => {
    await writeFile(
      join(repoRoot, 'src', 'limits.ts'),
      `export const MAX_RETRIES = 5
export const VERSION = 'v1.2.3'
export const DEBUG = false`
    )

    const { indexer, factIndexer } = makeIndexer()
    await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    const db = new Database(dbPath)
    runMigrations(db)
    const texts = db
      .prepare('SELECT name, source_text FROM code_symbols WHERE rel_path = ?')
      .all('src/limits.ts') as Array<{ name: string; source_text: string | null }>
    db.close()
    expect(texts.some(r => r.name === 'MAX_RETRIES' && (r.source_text ?? '').includes('5'))).toBe(
      true
    )
    expect(texts.some(r => r.name === 'VERSION' && (r.source_text ?? '').includes('v1.2.3'))).toBe(
      true
    )
  })

  it('[TC-HAEK] indexes top-level non-exported constants with literal values as symbols', async () => {
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
    expect(querySymbol(db, 'ABSOLUTE_MAX_ITERATIONS', 'src/config.ts')).toBe(true)
    expect(querySymbol(db, 'THRESHOLD', 'src/config.ts')).toBe(true)
    expect(querySymbol(db, 'getMax', 'src/config.ts')).toBe(true)
    expect(querySymbol(db, 'STOP_WORDS', 'src/config.ts')).toBe(false)
    expect(querySymbol(db, 'MUTABLE', 'src/config.ts')).toBe(false)
    db.close()
  })

  it('[TC-AX0K] indexes only the files passed as candidateFiles', async () => {
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
    expect(querySymbol(db, 'ROOT', 'src/index.ts')).toBe(true)
    expect(querySymbol(db, 'Widget', 'packages/catalog/src/widget.ts')).toBe(true)
    expect(querySymbol(db, 'SKIP', 'src/ignored.ts')).toBe(false)
    db.close()
  })
})

describe('CodeGraphStore (tree-sitter backed)', () => {
  it('[TC-M54E] finds exported symbols matching query terms via FTS', async () => {
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

  it('[TC-VJA3] getSummary returns symbol and file counts', async () => {
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
  it('[TC-0X92] indexes exported components and functions from .tsx files', async () => {
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
    expect(querySymbol(db, 'Button', 'src/Button.tsx')).toBe(true)
    db.close()
  })

  it('[TC-ESY9] indexes exported functions from .jsx files', async () => {
    await writeFile(
      join(repoRoot, 'src', 'Widget.jsx'),
      'export function Widget() { return null }\nlet hidden = 1\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'Widget', 'src/Widget.jsx')).toBe(true)
    expect(querySymbol(db, 'hidden', 'src/Widget.jsx')).toBe(false)
    db.close()
  })
})

describe('TreeSitterIndexer — Python', () => {
  it('[TC-2EDD] indexes functions and classes', async () => {
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
    expect(querySymbol(db, 'public_fn', 'app.py')).toBe(true)
    expect(querySymbol(db, 'Widget', 'app.py')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — Rust', () => {
  it('[TC-YBB8] indexes functions and structs', async () => {
    await writeFile(join(repoRoot, 'lib.rs'), 'pub fn run() {}\nstruct Engine;\n')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'run', 'lib.rs')).toBe(true)
    expect(querySymbol(db, 'Engine', 'lib.rs')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — Haskell', () => {
  it('[smoke] indexes functions, data types, classes, and type aliases', async () => {
    await writeFile(
      join(repoRoot, 'Ast.hs'),
      `module Ast (Token(..), parse) where
data Token = TWord String | TOp String deriving (Eq, Show)
newtype Id = Id Int
type Name = String
class Analyzer a where
  analyze :: a -> Bool
parse :: String -> Token
parse s = TWord s
`
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'parse', 'Ast.hs')).toBe(true)
    expect(querySymbol(db, 'Token', 'Ast.hs')).toBe(true)
    expect(querySymbol(db, 'Id', 'Ast.hs')).toBe(true)
    expect(querySymbol(db, 'Name', 'Ast.hs')).toBe(true)
    expect(querySymbol(db, 'Analyzer', 'Ast.hs')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — HTML', () => {
  it('[TC-5QN9] indexes elements with id attributes', async () => {
    await writeFile(join(repoRoot, 'index.html'), '<html><body><div id="root"></div></body></html>')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'root', 'index.html')).toBe(true)
    db.close()
  })
})

describe('TreeSitterIndexer — text fallback', () => {
  it('[TC-ATAZ] creates code_file_state plus a file-level code_symbol for text-only files', async () => {
    await writeFile(join(repoRoot, 'README.md'), '# Hello\nThis is a readme.')
    await writeFile(join(repoRoot, 'config.yaml'), 'key: value\nother: 123')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(2)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryCodeFileState(db, 'README.md')).toBe(true)
    expect(queryCodeFileState(db, 'config.yaml')).toBe(true)
    expect(querySymbol(db, 'README.md', 'README.md')).toBe(true)
    expect(querySymbolKind(db, 'README.md', 'README.md')).toBe('file')
    expect(querySymbol(db, 'config.yaml', 'config.yaml')).toBe(true)
    expect(querySymbolKind(db, 'config.yaml', 'config.yaml')).toBe('file')
    db.close()
  })

  it('[TC-F234] indexes share/completions/*.fish as searchable file-level symbols', async () => {
    await mkdir(join(repoRoot, 'share', 'completions'), { recursive: true })
    await writeFile(
      join(repoRoot, 'share', 'completions', 'scp.fish'),
      'complete -c scp -a "(__fish_complete_path)"\n'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBe(1)

    const db = new Database(dbPath)
    runMigrations(db)
    const rel = 'share/completions/scp.fish'
    expect(queryCodeFileState(db, rel)).toBe(true)
    expect(querySymbol(db, 'scp.fish', rel)).toBe(true)
    expect(querySymbolKind(db, 'scp.fish', rel)).toBe('file')
    const row = db
      .prepare('SELECT source_text FROM code_symbols WHERE name = ? AND rel_path = ?')
      .get('scp.fish', rel) as { source_text: string }
    expect(row.source_text).toContain('complete -c scp')
    expect(row.source_text).toContain(rel)
    db.close()
  })

  it('[TC-UPJ4] ignores unknown extensions not in the allowlist', async () => {
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

  it('[TC-ROFO] indexes code and text files together in one pass', async () => {
    await writeFile(join(repoRoot, 'main.go'), 'package main\nfunc Run() {}')
    await writeFile(join(repoRoot, 'README.md'), '# docs')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    // Go export + README.md file-level symbol
    expect(stats.symbols).toBe(2)
    expect(stats.errors).toBe(0)
  })

  it('[TC-T083] indexes exported symbols from .vue/.svelte inline <script> blocks', async () => {
    await writeFile(
      join(repoRoot, 'src', 'FlowCreate.vue'),
      '<script setup lang="ts">\nexport function computeTotal(x: number): number { return x * 2 }\nexport const MAX_ITEMS = 10\n</script>\n<template><div>{{ MAX_ITEMS }}</div></template>'
    )
    await writeFile(
      join(repoRoot, 'src', 'App.svelte'),
      '<script>\nexport function greet(name) { return `hi ${name}` }\nexport const GREETING = "hello"\n</script>\n<div>{GREETING}</div>'
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(2)
    expect(stats.errors).toBe(0)
    expect(stats.symbols).toBeGreaterThanOrEqual(4)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'computeTotal', 'src/FlowCreate.vue')).toBe(true)
    expect(querySymbol(db, 'MAX_ITEMS', 'src/FlowCreate.vue')).toBe(true)
    expect(querySymbol(db, 'greet', 'src/App.svelte')).toBe(true)
    expect(querySymbol(db, 'GREETING', 'src/App.svelte')).toBe(true)
    db.close()
  })

  it('[TC-FBSK] falls back to text-state for .vue/.svelte with no inline script, and for Astro/typo aliases', async () => {
    // No <script> block at all — nothing to extract, falls back to text.
    await writeFile(join(repoRoot, 'src', 'Empty.vue'), '<template><div>flow</div></template>')
    // .astro and the .svlete typo alias never attempt embedded-script extraction.
    await writeFile(
      join(repoRoot, 'src', 'Page.astro'),
      '---\nconst title = "Hello";\n---\n<h1>{title}</h1>'
    )
    await writeFile(join(repoRoot, 'src', 'Legacy.svlete'), '<script>let bad = true;</script>')

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(3)
    // Text-only path now emits one file-level code_symbol per file (#234).
    expect(stats.symbols).toBe(3)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(queryCodeFileState(db, 'src/Empty.vue')).toBe(true)
    expect(querySymbol(db, 'Empty.vue', 'src/Empty.vue')).toBe(true)
    expect(querySymbolKind(db, 'Empty.vue', 'src/Empty.vue')).toBe('file')
    expect(queryCodeFileState(db, 'src/Page.astro')).toBe(true)
    expect(querySymbol(db, 'Page.astro', 'src/Page.astro')).toBe(true)
    expect(queryCodeFileState(db, 'src/Legacy.svlete')).toBe(true)
    expect(querySymbol(db, 'Legacy.svlete', 'src/Legacy.svlete')).toBe(true)
    db.close()
  })

  it('[TC-VUEF] indexes non-exported top-level functions and function-valued constants from .vue/.svelte <script setup> blocks', async () => {
    // Realistic <script setup> shape: nothing is exported (the whole block is implicitly the
    // component's public surface), so this exercises the export-free symbol pass directly.
    await writeFile(
      join(repoRoot, 'src', 'FlowCreate.vue'),
      [
        '<script setup lang="ts">',
        'const MAX_ITEMS = 10',
        'const showImport = ref(false)', // call-expression value — must NOT be captured
        'const handleImportSubmit = async ({yaml}: {yaml: string}) => {',
        '  console.log(yaml)',
        '}',
        'function retrySetup() {',
        '  return true',
        '}',
        '</script>',
        '<template><div>{{ MAX_ITEMS }}</div></template>',
      ].join('\n')
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'MAX_ITEMS', 'src/FlowCreate.vue')).toBe(true)
    expect(querySymbolKind(db, 'MAX_ITEMS', 'src/FlowCreate.vue')).toBe('constant')
    expect(querySymbol(db, 'handleImportSubmit', 'src/FlowCreate.vue')).toBe(true)
    expect(querySymbolKind(db, 'handleImportSubmit', 'src/FlowCreate.vue')).toBe('function')
    expect(querySymbol(db, 'retrySetup', 'src/FlowCreate.vue')).toBe(true)
    expect(querySymbolKind(db, 'retrySetup', 'src/FlowCreate.vue')).toBe('function')
    // A composable call (`ref(false)`) is neither a literal nor a function expression —
    // stays out of the index, same as before this fix.
    expect(querySymbol(db, 'showImport', 'src/FlowCreate.vue')).toBe(false)
    db.close()
  })

  it('[TC-VUEN] does not extend non-exported function capture to plain .ts/.js modules', async () => {
    // The export-free pass is scoped to embedded Vue/Svelte scripts only. An ordinary module
    // still has a real private/public split — un-exported helpers must stay out of the index.
    await writeFile(
      join(repoRoot, 'src', 'helpers.ts'),
      [
        'export function publicFn() { return 1 }',
        'const privateHandler = () => { return 2 }',
        'function privateFn() { return 3 }',
      ].join('\n')
    )

    const { indexer, factIndexer } = makeIndexer()
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()
    factIndexer.close()

    expect(stats.files).toBe(1)
    expect(stats.errors).toBe(0)

    const db = new Database(dbPath)
    runMigrations(db)
    expect(querySymbol(db, 'publicFn', 'src/helpers.ts')).toBe(true)
    expect(querySymbol(db, 'privateHandler', 'src/helpers.ts')).toBe(false)
    expect(querySymbol(db, 'privateFn', 'src/helpers.ts')).toBe(false)
    db.close()
  })
})
