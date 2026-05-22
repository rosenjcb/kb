import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { TreeSitterIndexer } from '../../src/tools/tree-sitter-indexer'
import { CodeGraphStore } from '../../src/tools/code-graph-store'

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

describe('TreeSitterIndexer — Go', () => {
  it('indexes exported functions and types', async () => {
    await writeFile(
      join(repoRoot, 'server.go'),
      'package main\n\nfunc Start() error { return nil }\nfunc internalHelper() {}\ntype Server struct { Host string }\ntype privateStruct struct{}\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBe(1)
    expect(stats.errors).toBe(0)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)

    const store = new CodeGraphStore(dbPath)
    const fileNode = store.getNode('file:server.go')
    expect(fileNode).not.toBeNull()
    expect(fileNode?.kind).toBe('file')

    const startSymbol = store.getNode('symbol:server.go#Start')
    expect(startSymbol).not.toBeNull()
    expect(startSymbol?.exported).toBe(true)

    // unexported should not be indexed
    expect(store.getNode('symbol:server.go#internalHelper')).toBeNull()
    store.close()
  })

  it('indexes exported methods', async () => {
    await writeFile(
      join(repoRoot, 'handler.go'),
      'package main\n\ntype Handler struct{}\n\nfunc (h *Handler) ServeHTTP() {}\nfunc (h *Handler) internalReset() {}\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.symbols).toBeGreaterThanOrEqual(2) // Handler + ServeHTTP
    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:handler.go#ServeHTTP')).not.toBeNull()
    expect(store.getNode('symbol:handler.go#internalReset')).toBeNull()
    store.close()
  })

  it('indexes exported constants and variables', async () => {
    await writeFile(
      join(repoRoot, 'config.go'),
      'package main\n\nconst MaxRetries = 3\nconst internalTimeout = 5\nvar DefaultAddr = ":8080"\nvar privateKey = "secret"\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    await indexer.indexProject(repoRoot)
    indexer.close()

    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:config.go#MaxRetries')).not.toBeNull()
    expect(store.getNode('symbol:config.go#DefaultAddr')).not.toBeNull()
    expect(store.getNode('symbol:config.go#internalTimeout')).toBeNull()
    expect(store.getNode('symbol:config.go#privateKey')).toBeNull()
    store.close()
  })

  it('emits IMPORTS_FILE edges for resolvable local Go imports', async () => {
    await mkdir(join(repoRoot, 'pkg'), { recursive: true })
    await writeFile(join(repoRoot, 'pkg', 'util.go'), 'package pkg\nfunc Helper() {}')
    await writeFile(
      join(repoRoot, 'main.go'),
      'package main\nimport "./pkg"\nfunc main() {}'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBeGreaterThanOrEqual(1)
    expect(stats.errors).toBe(0)
  })

  it('does not emit IMPORTS_FILE edges for unresolvable Go module paths', async () => {
    await writeFile(
      join(repoRoot, 'main.go'),
      'package main\nimport "github.com/some/external/pkg"\nfunc main() {}'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    // No edges — external module paths are skipped
    expect(stats.edges).toBe(0)
    expect(stats.errors).toBe(0)
  })

  it('skips unchanged files on re-index', async () => {
    await writeFile(join(repoRoot, 'stable.go'), 'package main\nfunc Stable() {}')

    const indexer = new TreeSitterIndexer(dbPath)
    const first = await indexer.indexProject(repoRoot)
    const second = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(first.files).toBe(1)
    expect(second.files).toBe(0)
    expect(second.skipped).toBe(1)
  })

})

describe('TreeSitterIndexer — TypeScript', () => {
  it('indexes exported classes and functions', async () => {
    await writeFile(
      join(repoRoot, 'src', 'utils.ts'),
      "export class MyService {}\nexport function compute(x: number): number { return x * 2 }\nexport const VERSION = '1.0'\nfunction privateHelper() {}\n"
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(3)
    expect(stats.errors).toBe(0)

    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:src/utils.ts#MyService')).not.toBeNull()
    expect(store.getNode('symbol:src/utils.ts#compute')).not.toBeNull()
    expect(store.getNode('symbol:src/utils.ts#VERSION')).not.toBeNull()
    store.close()
  })

  it('indexes exported interfaces and type aliases', async () => {
    await writeFile(
      join(repoRoot, 'src', 'types.ts'),
      'export interface Config { port: number }\nexport type Handler = (req: unknown) => void\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    await indexer.indexProject(repoRoot)
    indexer.close()

    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:src/types.ts#Config')).not.toBeNull()
    expect(store.getNode('symbol:src/types.ts#Handler')).not.toBeNull()
    store.close()
  })

  it('emits IMPORTS_FILE edges for local TS imports', async () => {
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const x = 1')
    await writeFile(join(repoRoot, 'src', 'b.ts'), "import { x } from './a'\nexport const y = x + 1")

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.edges).toBeGreaterThanOrEqual(1)

    const db = new Database(dbPath)
    const edges = db
      .prepare("SELECT from_id, to_id FROM kg_edges WHERE type = 'IMPORTS_FILE'")
      .all() as Array<{ from_id: string; to_id: string }>
    db.close()

    expect(edges.length).toBeGreaterThanOrEqual(1)
    const edge = edges.find(e => e.from_id === 'file:src/b.ts')
    expect(edge?.to_id).toBe('file:src/a.ts')
  })
})

describe('TreeSitterIndexer — TSX', () => {
  it('indexes exported components and functions from .tsx files', async () => {
    await writeFile(
      join(repoRoot, 'src', 'Button.tsx'),
      "import React from './react'\nexport function Button() { return null }\nexport const IconButton = () => null\n"
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.errors).toBe(0)
    const store = new CodeGraphStore(dbPath)
    const fileNode = store.getNode('file:src/Button.tsx')
    expect(fileNode).not.toBeNull()
    expect(fileNode?.language).toBe('tsx')
    expect(store.getNode('symbol:src/Button.tsx#Button')).not.toBeNull()
    store.close()
  })
})

describe('TreeSitterIndexer — Python', () => {
  it('indexes functions and classes', async () => {
    await writeFile(
      join(repoRoot, 'app.py'),
      'def public_fn():\n    pass\n\nclass Widget:\n    pass\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThanOrEqual(2)
    expect(stats.errors).toBe(0)

    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:app.py#public_fn')).not.toBeNull()
    expect(store.getNode('symbol:app.py#Widget')).not.toBeNull()
    store.close()
  })
})

describe('TreeSitterIndexer — Rust', () => {
  it('indexes functions and structs', async () => {
    await writeFile(
      join(repoRoot, 'lib.rs'),
      'pub fn run() {}\nstruct Engine;\n'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.errors).toBe(0)
    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('symbol:lib.rs#run')).not.toBeNull()
    expect(store.getNode('symbol:lib.rs#Engine')).not.toBeNull()
    store.close()
  })
})

describe('TreeSitterIndexer — HTML', () => {
  it('indexes elements with id attributes', async () => {
    await writeFile(
      join(repoRoot, 'index.html'),
      '<html><body><div id="root"></div></body></html>'
    )

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.errors).toBe(0)
    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('file:index.html')?.language).toBe('html')
    expect(store.getNode('symbol:index.html#root')).not.toBeNull()
    store.close()
  })
})

describe('TreeSitterIndexer — text fallback', () => {
  it('creates a file node for non-code files without extracting symbols', async () => {
    await writeFile(join(repoRoot, 'README.md'), '# Hello\nThis is a readme.')
    await writeFile(join(repoRoot, 'config.yaml'), 'key: value\nother: 123')

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(0)
    expect(stats.errors).toBe(0)

    const store = new CodeGraphStore(dbPath)
    const readmeNode = store.getNode('file:README.md')
    expect(readmeNode).not.toBeNull()
    expect(readmeNode?.kind).toBe('file')
    expect(readmeNode?.language).toBe('text')

    const yamlNode = store.getNode('file:config.yaml')
    expect(yamlNode).not.toBeNull()
    expect(yamlNode?.language).toBe('text')
    store.close()
  })

  it('ignores unknown extensions not in the allowlist', async () => {
    await writeFile(join(repoRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(repoRoot, 'go.sum'), 'github.com/foo/bar v1.0.0 h1:abc=')
    await writeFile(join(repoRoot, 'config.yaml'), 'key: value') // .yaml IS in TEXT_EXTS

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    // .png and .sum are not in EXT_MAP or TEXT_EXTS → ignored
    // .yaml is in TEXT_EXTS → gets a file node
    expect(stats.files).toBe(1)
    const store = new CodeGraphStore(dbPath)
    expect(store.getNode('file:image.png')).toBeNull()
    expect(store.getNode('file:go.sum')).toBeNull()
    expect(store.getNode('file:config.yaml')).not.toBeNull()
    store.close()
  })

  it('indexes code and text files together in one pass', async () => {
    await writeFile(join(repoRoot, 'main.go'), 'package main\nfunc Run() {}')
    await writeFile(join(repoRoot, 'README.md'), '# docs')

    const indexer = new TreeSitterIndexer(dbPath)
    const stats = await indexer.indexProject(repoRoot)
    indexer.close()

    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(1) // only Run() from Go
    expect(stats.errors).toBe(0)
  })
})
