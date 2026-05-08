/**
 * Multi-language code graph indexer using web-tree-sitter (WASM grammars).
 *
 * Supports any language that has a tree-sitter-<lang> npm package with a
 * bundled .wasm file. Currently wired up: Go, TypeScript, TSX, JavaScript, JSX.
 *
 * Extracts file nodes, symbol nodes, and IMPORTS_FILE / EXPORTS_SYMBOL edges
 * into kg_* tables, then populates kg_semantic_bridge by name-matching symbols
 * to existing kb_graph_entities.
 */

import crypto from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { Parser, Language, Query } from 'web-tree-sitter'
import type { Tree } from 'web-tree-sitter'
import { runMigrations } from '../core/db-migrations'
import type { CodeIndexStats, CodeIndexOptions, LanguageIndexer } from './code-graph-indexer'

const require = createRequire(import.meta.url)

const SCHEMA_VERSION = 1
const SOURCE = 'tree-sitter'

// ---------------------------------------------------------------------------
// Language registry — maps file extension → WASM grammar path
// ---------------------------------------------------------------------------

interface LangConfig {
  wasmPath: string
  importQueries: string[]
  exportQueries: string[]
  // If true, only uppercase-initial names are considered "exported" (Go convention)
  goExportConvention: boolean
}

function resolveWasm(pkg: string, file: string): string {
  return require.resolve(`${pkg}/${file}`)
}

const LANG_CONFIGS: Record<string, LangConfig> = {
  go: {
    wasmPath: resolveWasm('tree-sitter-go', 'tree-sitter-go.wasm'),
    importQueries: ['(import_spec path: (interpreted_string_literal) @path)'],
    exportQueries: [
      '(function_declaration name: (identifier) @name)',
      '(method_declaration name: (field_identifier) @name)',
      '(type_declaration (type_spec name: (type_identifier) @name))',
      '(var_declaration (var_spec name: (identifier) @name))',
      '(const_declaration (const_spec name: (identifier) @name))',
    ],
    goExportConvention: true,
  },
  ts: {
    wasmPath: resolveWasm('tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
    importQueries: ['(import_statement source: (string (string_fragment) @path))'],
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
      '(export_statement declaration: (interface_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (type_alias_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (enum_declaration name: (identifier) @name))',
    ],
    goExportConvention: false,
  },
  tsx: {
    wasmPath: resolveWasm('tree-sitter-typescript', 'tree-sitter-tsx.wasm'),
    importQueries: ['(import_statement source: (string (string_fragment) @path))'],
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
      '(export_statement declaration: (interface_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (type_alias_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))',
    ],
    goExportConvention: false,
  },
  js: {
    wasmPath: resolveWasm('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
    importQueries: ['(import_statement source: (string (string_fragment) @path))'],
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
    ],
    goExportConvention: false,
  },
  jsx: {
    wasmPath: resolveWasm('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
    importQueries: ['(import_statement source: (string (string_fragment) @path))'],
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
    ],
    goExportConvention: false,
  },
}

// Extension → language key (known AST-able extensions)
const EXT_MAP: Record<string, string> = {
  '.go': 'go',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
}

// Text/config extensions we index as plain file nodes (no AST, no symbols).
// Anything not in EXT_MAP or TEXT_EXTS is ignored entirely.
const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sh', '.bash', '.zsh', '.fish',
  '.dockerfile', '.containerfile',
  '.graphql', '.gql',
  '.proto',
  '.sql',
  '.tf', '.hcl',
  '',         // extensionless files (Makefile, Dockerfile, etc.)
])

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', 'coverage', '__pycache__',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function hashFile(filePath: string): string {
  try {
    return crypto.createHash('sha1').update(readFileSync(filePath)).digest('hex')
  } catch {
    return ''
  }
}

function relPath(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).replace(/\\/g, '/')
}

function fileId(rel: string): string {
  return `file:${rel}`
}

function symbolId(rel: string, name: string): string {
  return `symbol:${rel}#${name}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

function isExported(name: string, goConvention: boolean): boolean {
  if (!goConvention) return true
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
}

function* walkFiles(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    let st: ReturnType<typeof statSync> | undefined
    try { st = statSync(full) } catch { continue }
    if (st?.isDirectory()) {
      yield* walkFiles(full)
    } else if (st?.isFile()) {
      yield full
    }
  }
}

// ---------------------------------------------------------------------------
// Per-language compiled query cache
// ---------------------------------------------------------------------------

interface CompiledLang {
  language: Language
  importQueries: Query[]
  exportQueries: Query[]
  config: LangConfig
}

// ---------------------------------------------------------------------------
// TreeSitterIndexer
// ---------------------------------------------------------------------------

export class TreeSitterIndexer implements LanguageIndexer {
  private db: Database.Database
  private parser: Parser | null = null
  private langCache = new Map<string, CompiledLang>()

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  async indexProject(repoRoot: string, opts: CodeIndexOptions = {}): Promise<CodeIndexStats> {
    await this.ensureParser()

    const stats: CodeIndexStats = { files: 0, symbols: 0, edges: 0, skipped: 0, errors: 0 }

    const insertNode = this.db.prepare(`
      INSERT INTO kg_nodes
        (id, kind, subkind, name, qualified_name, path, file_id, language,
         span_start, span_end, exported, source, confidence, props_json,
         content_hash, updated_at)
      VALUES
        (@id, @kind, @subkind, @name, @qualifiedName, @path, @fileId, @language,
         @spanStart, @spanEnd, @exported, @source, @confidence, @propsJson,
         @contentHash, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, subkind = excluded.subkind, name = excluded.name,
        qualified_name = excluded.qualified_name, path = excluded.path,
        file_id = excluded.file_id, language = excluded.language,
        span_start = excluded.span_start, span_end = excluded.span_end,
        exported = excluded.exported, source = excluded.source,
        confidence = excluded.confidence, props_json = excluded.props_json,
        content_hash = excluded.content_hash, updated_at = excluded.updated_at
    `)

    const insertFts = this.db.prepare(`
      INSERT OR REPLACE INTO kg_nodes_fts(id, name, qualified_name, path)
      VALUES (@id, @name, @qualifiedName, @path)
    `)

    const stubFileNode = this.db.prepare(`
      INSERT OR IGNORE INTO kg_nodes
        (id, kind, name, qualified_name, path, source, confidence, props_json, updated_at)
      VALUES (@id, 'file', @name, @qualifiedName, @path, @source, 1.0, '{}', datetime('now'))
    `)

    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO kg_edges
        (id, from_id, to_id, type, source, confidence, props_json, updated_at)
      VALUES (@id, @fromId, @toId, @type, @source, @confidence, @propsJson, datetime('now'))
    `)

    const upsertFileState = this.db.prepare(`
      INSERT OR REPLACE INTO kg_file_state
        (file_id, path, content_hash, extractor, schema_version, indexed_at, success, error_text)
      VALUES (@fileId, @path, @contentHash, @extractor, @schemaVersion, datetime('now'), @success, @errorText)
    `)

    const getFileState = this.db.prepare(
      'SELECT content_hash FROM kg_file_state WHERE file_id = ? AND success = 1 AND schema_version = ?'
    )

    const indexFile = this.db.transaction((absPath: string) => {
      const rel = relPath(repoRoot, absPath)
      const ext = path.extname(rel).toLowerCase()
      const langKey = EXT_MAP[ext]
      const contentHash = hashFile(absPath)
      const fid = fileId(rel)
      const effectiveLang = langKey ?? 'text'

      const existing = getFileState.get(fid, SCHEMA_VERSION) as { content_hash: string } | undefined
      if (existing?.content_hash === contentHash) {
        stats.skipped++
        return
      }

      let src: string
      try {
        src = readFileSync(absPath, 'utf8')
      } catch {
        stats.errors++
        return
      }

      // File node — every file gets one regardless of language
      insertNode.run({
        id: fid, kind: 'file', subkind: effectiveLang,
        name: path.basename(rel), qualifiedName: rel,
        path: rel, fileId: null, language: effectiveLang,
        spanStart: 0, spanEnd: src.length,
        exported: 0, source: SOURCE, confidence: 1.0,
        propsJson: '{}', contentHash,
      })
      insertFts.run({ id: fid, name: path.basename(rel), qualifiedName: rel, path: rel })
      stats.files++

      // Text fallback — no AST support for this extension, just the file node
      const compiled = langKey ? this.langCache.get(langKey) : undefined
      if (!compiled) {
        upsertFileState.run({ fileId: fid, path: rel, contentHash, extractor: SOURCE, schemaVersion: SCHEMA_VERSION, success: 1, errorText: null })
        return
      }

      let tree: Tree | null
      const parser = this.parser as Parser
      try {
        parser.setLanguage(compiled.language)
        tree = parser.parse(src)
      } catch {
        stats.errors++
        upsertFileState.run({ fileId: fid, path: rel, contentHash, extractor: SOURCE, schemaVersion: SCHEMA_VERSION, success: 0, errorText: 'parse failed' })
        return
      }
      if (tree == null) return

      // Imports → IMPORTS_FILE edges
      for (const q of compiled.importQueries) {
        for (const match of q.matches(tree.rootNode)) {
          const importPath = match.captures[0]?.node.text
          if (!importPath) continue
          // Only local imports (starts with . or /)
          if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue
          const resolved = path.resolve(path.dirname(absPath), importPath)
          // Try common extensions
          const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}/index.js`]
          let targetRel: string | null = null
          for (const c of candidates) {
            try { statSync(c); targetRel = relPath(repoRoot, c); break } catch { /* noop */ }
          }
          if (!targetRel) continue
          const targetId = fileId(targetRel)
          stubFileNode.run({ id: targetId, name: path.basename(targetRel), qualifiedName: targetRel, path: targetRel, source: SOURCE })
          insertEdge.run({
            id: sha1(`${fid}|IMPORTS_FILE|${targetId}`),
            fromId: fid, toId: targetId, type: 'IMPORTS_FILE',
            source: SOURCE, confidence: 0.95,
            propsJson: JSON.stringify({ specifier: importPath }),
          })
          stats.edges++
        }
      }

      // Exports → symbol nodes + EXPORTS_SYMBOL edges
      for (const q of compiled.exportQueries) {
        for (const match of q.matches(tree.rootNode)) {
          const capture = match.captures[0]
          const name = capture?.node.text
          if (!name || !capture) continue
          if (!isExported(name, compiled.config.goExportConvention)) continue
          const node = capture.node
          const sid = symbolId(rel, name)
          insertNode.run({
            id: sid, kind: 'symbol', subkind: node.type,
            name, qualifiedName: `${rel}::${name}`,
            path: rel, fileId: fid, language: effectiveLang,
            spanStart: node.startIndex, spanEnd: node.endIndex,
            exported: 1, source: SOURCE, confidence: 0.95,
            propsJson: '{}', contentHash: null,
          })
          insertFts.run({ id: sid, name, qualifiedName: `${rel}::${name}`, path: rel })
          stats.symbols++
          insertEdge.run({
            id: sha1(`${fid}|EXPORTS_SYMBOL|${sid}`),
            fromId: fid, toId: sid, type: 'EXPORTS_SYMBOL',
            source: SOURCE, confidence: 0.95, propsJson: '{}',
          })
          stats.edges++
        }
      }

      upsertFileState.run({ fileId: fid, path: rel, contentHash, extractor: SOURCE, schemaVersion: SCHEMA_VERSION, success: 1, errorText: null })
    })

    for (const absPath of walkFiles(repoRoot)) {
      const ext = path.extname(absPath).toLowerCase()
      const langKey = EXT_MAP[ext]
      if (!langKey && !TEXT_EXTS.has(ext)) continue
      // If we have an AST grammar for this extension, load it before indexing
      if (langKey && LANG_CONFIGS[langKey]) {
        try {
          await this.ensureLang(langKey)
        } catch {
          // Grammar load failed — fall through to text-node-only path
        }
      }
      try {
        indexFile(absPath)
      } catch {
        stats.errors++
      }
      opts.onProgress?.(stats)
    }

    this.populateSemanticBridge()
    return stats
  }

  private async ensureParser(): Promise<void> {
    if (this.parser) return
    await Parser.init()
    this.parser = new Parser()
  }

  private async ensureLang(key: string): Promise<void> {
    if (this.langCache.has(key)) return
    const config = LANG_CONFIGS[key]
    if (!config) throw new Error(`No config for language: ${key}`)
    const language = await Language.load(config.wasmPath)
    const compiled: CompiledLang = {
      language,
      importQueries: config.importQueries.map(s => new Query(language, s)),
      exportQueries: config.exportQueries.map(s => new Query(language, s)),
      config,
    }
    this.langCache.set(key, compiled)
  }

  private populateSemanticBridge(): void {
    const entityIds = (
      this.db.prepare('SELECT id, name FROM kb_graph_entities').all() as Array<{ id: string; name: string }>
    ).reduce<Map<string, string>>((m, r) => {
      m.set(slugify(r.name), r.id)
      return m
    }, new Map())

    if (entityIds.size === 0) return

    const symbols = this.db
      .prepare("SELECT id, name FROM kg_nodes WHERE kind = 'symbol' AND source = ?")
      .all(SOURCE) as Array<{ id: string; name: string }>

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO kg_semantic_bridge
        (code_node_id, semantic_entity_id, match_type, confidence, created_at)
      VALUES (?, ?, 'name_match', 0.8, datetime('now'))
    `)

    const tx = this.db.transaction(() => {
      for (const sym of symbols) {
        const entityId = entityIds.get(slugify(sym.name))
        if (entityId) insert.run(sym.id, entityId)
      }
    })
    tx()
  }
}
