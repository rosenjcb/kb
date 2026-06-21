/**
 * Multi-language code graph indexer using web-tree-sitter (WASM grammars).
 *
 * Supports any language that has a tree-sitter-<lang> npm package with a
 * bundled .wasm file. See LANG_CONFIGS / EXT_MAP for the wired-up set.
 *
 * Writes exported symbol facts, IMPORTS_FILE bridge facts, and structural relationship
 * facts into the facts table via SqliteKbIndexer.
 */

import crypto from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { Parser, Language, Query } from 'web-tree-sitter'
import type { Tree } from 'web-tree-sitter'
import { runMigrations } from '../core/db-migrations'
import { yieldEvery } from '../core/yield'
import type { CodeIndexStats, CodeIndexOptions, LanguageIndexer } from './code-graph-indexer'
import type { Node as TsNode } from 'web-tree-sitter'
import {
  getCodeFileState,
  upsertCodeFileFact,
  upsertCodeFileState,
} from './code-fact-writer'
import type { SqliteKbIndexer } from './sqlite-kb-index'

const require = createRequire(import.meta.url)

const SOURCE = 'tree-sitter'

/** Walk up from a captured @name node to the nearest top-level declaration. */
function getDeclNode(nameNode: TsNode): TsNode {
  let n: TsNode = nameNode
  while (n.parent?.parent != null) {
    n = n.parent
  }
  return n
}

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
  python: {
    wasmPath: resolveWasm('tree-sitter-python', 'tree-sitter-python.wasm'),
    importQueries: [],
    exportQueries: [
      '(function_definition name: (identifier) @name)',
      '(class_definition name: (identifier) @name)',
    ],
    goExportConvention: false,
  },
  rust: {
    wasmPath: resolveWasm('tree-sitter-rust', 'tree-sitter-rust.wasm'),
    importQueries: [],
    exportQueries: [
      '(function_item name: (identifier) @name)',
      '(struct_item name: (type_identifier) @name)',
      '(enum_item name: (type_identifier) @name)',
      '(trait_item name: (type_identifier) @name)',
      '(type_item name: (type_identifier) @name)',
      '(const_item name: (identifier) @name)',
      '(mod_item name: (identifier) @name)',
    ],
    goExportConvention: false,
  },
  ruby: {
    wasmPath: resolveWasm('tree-sitter-ruby', 'tree-sitter-ruby.wasm'),
    importQueries: [
      '((call method: (identifier) @method arguments: (argument_list (string (string_content) @path))) (#match? @method "^require"))',
    ],
    exportQueries: [
      '(method name: (identifier) @name)',
      '(singleton_method name: (identifier) @name)',
      '(class name: (constant) @name)',
      '(module name: (constant) @name)',
    ],
    goExportConvention: false,
  },
  java: {
    wasmPath: resolveWasm('tree-sitter-java', 'tree-sitter-java.wasm'),
    importQueries: [],
    exportQueries: [
      '(class_declaration name: (identifier) @name)',
      '(interface_declaration name: (identifier) @name)',
      '(enum_declaration name: (identifier) @name)',
      '(method_declaration name: (identifier) @name)',
      '(constructor_declaration name: (identifier) @name)',
    ],
    goExportConvention: false,
  },
  c: {
    wasmPath: resolveWasm('tree-sitter-c', 'tree-sitter-c.wasm'),
    importQueries: [],
    exportQueries: [
      '(function_definition declarator: (function_declarator declarator: (identifier) @name))',
      '(declaration declarator: (function_declarator declarator: (identifier) @name))',
      '(type_definition declarator: (type_identifier) @name)',
      '(struct_specifier name: (type_identifier) @name)',
      '(enum_specifier name: (type_identifier) @name)',
    ],
    goExportConvention: false,
  },
  cpp: {
    wasmPath: resolveWasm('tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
    importQueries: [],
    exportQueries: [
      '(function_definition declarator: (function_declarator declarator: (identifier) @name))',
      '(declaration declarator: (function_declarator declarator: (identifier) @name))',
      '(class_specifier name: (type_identifier) @name)',
      '(struct_specifier name: (type_identifier) @name)',
      '(enum_specifier name: (type_identifier) @name)',
    ],
    goExportConvention: false,
  },
  csharp: {
    wasmPath: resolveWasm('tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm'),
    importQueries: [],
    exportQueries: [
      '(class_declaration name: (identifier) @name)',
      '(interface_declaration name: (identifier) @name)',
      '(struct_declaration name: (identifier) @name)',
      '(enum_declaration name: (identifier) @name)',
      '(method_declaration name: (identifier) @name)',
      '(constructor_declaration name: (identifier) @name)',
    ],
    goExportConvention: false,
  },
  css: {
    wasmPath: resolveWasm('tree-sitter-css', 'tree-sitter-css.wasm'),
    importQueries: [],
    exportQueries: [
      '(class_selector (class_name) @name)',
      '(id_selector (id_name) @name)',
    ],
    goExportConvention: false,
  },
  bash: {
    wasmPath: resolveWasm('tree-sitter-bash', 'tree-sitter-bash.wasm'),
    importQueries: [
      '(source_command (word) @path)',
    ],
    exportQueries: [
      '(function_definition name: (word) @name)',
    ],
    goExportConvention: false,
  },
  php: {
    wasmPath: resolveWasm('tree-sitter-php', 'tree-sitter-php_only.wasm'),
    importQueries: [
      '(include_expression (string (string_content) @path))',
      '(include_once_expression (string (string_content) @path))',
      '(require_expression (string (string_content) @path))',
      '(require_once_expression (string (string_content) @path))',
    ],
    exportQueries: [
      '(function_definition name: (name) @name)',
      '(class_declaration name: (name) @name)',
      '(interface_declaration name: (name) @name)',
      '(trait_declaration name: (name) @name)',
      '(method_declaration name: (name) @name)',
    ],
    goExportConvention: false,
  },
  scala: {
    wasmPath: resolveWasm('tree-sitter-scala', 'tree-sitter-scala.wasm'),
    importQueries: [],
    exportQueries: [
      '(function_definition name: (identifier) @name)',
      '(function_declaration name: (identifier) @name)',
      '(class_definition name: (identifier) @name)',
      '(object_definition name: (identifier) @name)',
      '(trait_definition name: (identifier) @name)',
      '(val_definition pattern: (identifier) @name)',
    ],
    goExportConvention: false,
  },
  html: {
    wasmPath: resolveWasm('tree-sitter-html', 'tree-sitter-html.wasm'),
    importQueries: [],
    exportQueries: [
      '(element (start_tag (attribute (attribute_name) @attr (quoted_attribute_value (attribute_value) @name)) (#eq? @attr "id")))',
      '(script_element (start_tag (attribute (attribute_name) @attr (quoted_attribute_value (attribute_value) @name)) (#eq? @attr "id")))',
      '(style_element (start_tag (attribute (attribute_name) @attr (quoted_attribute_value (attribute_value) @name)) (#eq? @attr "id")))',
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
  // Python
  '.py': 'python',
  // Rust
  '.rs': 'rust',
  // Ruby
  '.rb': 'ruby',
  // Java
  '.java': 'java',
  // C
  '.c': 'c',
  '.h': 'c',
  // C++
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  // C#
  '.cs': 'csharp',
  // CSS (also listed in TREE_SITTER_TEXT_EXTENSIONS for indexability)
  '.css': 'css',
  // Bash / shell (also listed in TREE_SITTER_TEXT_EXTENSIONS)
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  // PHP
  '.php': 'php',
  // Scala
  '.scala': 'scala',
  // HTML
  '.html': 'html',
  '.htm': 'html',
}

/** File extensions with a WASM grammar in LANG_CONFIGS (leading dot). */
export const TREE_SITTER_AST_EXTENSIONS = new Set(Object.keys(EXT_MAP))

// Text/config extensions we index as plain file nodes (no AST, no symbols).
// Anything not in EXT_MAP or TEXT_EXTS is ignored entirely.
export const TREE_SITTER_TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.xml', '.scss', '.sass', '.less',
  '.fish',
  '.dockerfile', '.containerfile',
  '.graphql', '.gql',
  '.proto',
  '.sql',
  '.tf', '.hcl',
  '',         // extensionless files (Makefile, Dockerfile, etc.)
])

export const TREE_SITTER_SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', 'coverage', '__pycache__',
  '.cache', '.pytest_cache', '.tox', 'venv', '.venv',
  // Generated / mirrored docs — not source-of-truth for retrieval
  '_site', '_original_docs', '_autogenerated_docs', '_data', '_graph_pages',
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
    if (TREE_SITTER_SKIP_DIRS.has(name)) continue
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

export function isTreeSitterIndexablePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const ext = path.extname(normalized).toLowerCase()
  return Boolean(EXT_MAP[ext]) || TREE_SITTER_TEXT_EXTENSIONS.has(ext)
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
  private db: DatabaseSync
  private parser: Parser | null = null
  private langCache = new Map<string, CompiledLang>()

  constructor(
    dbPath: string,
    private factIndexer: SqliteKbIndexer
  ) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  async indexProject(repoRoot: string, opts: CodeIndexOptions = {}): Promise<CodeIndexStats> {
    await this.ensureParser()

    const stats: CodeIndexStats = { files: 0, symbols: 0, edges: 0, skipped: 0, errors: 0, sourceRefs: new Set() }
    const yieldStride = opts.yieldEveryFiles ?? 10
    const candidateFiles = opts.candidateFiles
      ?.map(file => file.replace(/\\/g, '/'))
      .filter(file => isTreeSitterIndexablePath(file))

    const indexFile = async (absPath: string) => {
      const rel = relPath(repoRoot, absPath)
      const ext = path.extname(rel).toLowerCase()
      const langKey = EXT_MAP[ext]
      const contentHash = hashFile(absPath)
      // Skip if ts-morph already handled this file
      const existing = getCodeFileState(this.db, rel)
      if (existing?.extractor === 'ts-morph') {
        stats.skipped++
        return
      }
      if (existing?.content_hash === contentHash && contentHash !== '') {
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

      stats.files++

      // Text-only files — no AST, no symbols, just record state
      const compiled = langKey ? this.langCache.get(langKey) : undefined
      if (!compiled) {
        upsertCodeFileState(this.db, rel, contentHash, SOURCE)
        return
      }

      let tree: Tree | null
      const parser = this.parser as Parser
      try {
        parser.setLanguage(compiled.language)
        tree = parser.parse(src)
      } catch {
        stats.errors++
        upsertCodeFileState(this.db, rel, contentHash, SOURCE)
        return
      }
      if (tree == null) return

      await this.factIndexer.runInTransaction(() => {
        // Imports → IMPORTS_FILE bridge facts
        for (const q of compiled.importQueries) {
          for (const match of q.matches(tree.rootNode)) {
            const importPath = match.captures[0]?.node.text
            if (!importPath) continue
            if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue
            const resolved = path.resolve(path.dirname(absPath), importPath)
            const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}/index.js`]
            let targetRel: string | null = null
            for (const c of candidates) {
              try { statSync(c); targetRel = relPath(repoRoot, c); break } catch { /* noop */ }
            }
            if (!targetRel) continue
            const sourceRef = `ast:import:${sha1(`${rel}→${targetRel}`)}`
            stats.sourceRefs.add(sourceRef)
            upsertCodeFileFact(
              this.factIndexer,
              sourceRef,
              `${rel} imports ${targetRel}`,
              { subject: rel, predicate: 'imports', object: targetRel },
              0.3
            )
            stats.edges++
          }
        }

        // Exports → symbol facts
        for (const q of compiled.exportQueries) {
          for (const match of q.matches(tree.rootNode)) {
            const capture = match.captures.find(c => c.name === 'name') ?? match.captures[0]
            const name = capture?.node.text
            if (!name || !capture) continue
            if (!isExported(name, compiled.config.goExportConvention)) continue
            const nameNode = capture.node
            const declNode = getDeclNode(nameNode)
            const rawText = src.slice(declNode.startIndex, declNode.endIndex)
            const sourceText = rawText.length > 1500 ? `${rawText.slice(0, 1497)}…` : rawText
            const sourceRef = `ast:${rel}@${name}`
            stats.sourceRefs.add(sourceRef)
            upsertCodeFileFact(
              this.factIndexer,
              sourceRef,
              `${name} is a ${nameNode.type} exported from ${rel}`,
              { subject: name, predicate: 'exported_from', object: rel },
              0.65,
              sourceText
            )
            stats.symbols++
          }
        }
      })

      upsertCodeFileState(this.db, rel, contentHash, SOURCE)
    }

    let processedFiles = 0
    const filesToIndex = candidateFiles
      ? candidateFiles.map(file => path.join(repoRoot, file))
      : walkFiles(repoRoot)
    for (const absPath of filesToIndex) {
      const ext = path.extname(absPath).toLowerCase()
      const langKey = EXT_MAP[ext]
      if (!langKey && !TREE_SITTER_TEXT_EXTENSIONS.has(ext)) continue
      if (langKey && LANG_CONFIGS[langKey]) {
        try {
          await this.ensureLang(langKey)
        } catch {
          // Grammar load failed — fall through to text-only path
        }
      }
      try {
        await indexFile(absPath)
      } catch {
        stats.errors++
      }
      processedFiles += 1
      opts.onProgress?.(stats)
      await yieldEvery(processedFiles, yieldStride)
    }

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

}
