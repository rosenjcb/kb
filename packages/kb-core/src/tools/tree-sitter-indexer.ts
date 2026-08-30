/**
 * Multi-language code graph indexer using web-tree-sitter (WASM grammars).
 *
 * Supports any language that has a tree-sitter-<lang> npm package with a
 * bundled .wasm file. See LANG_CONFIGS / EXT_MAP for the wired-up set.
 *
 * Writes one `code_symbols` row per exported symbol (with its source text). Import,
 * `extends` and `implements` relationships are parsed but no longer stored — the index
 * has no fact graph to hang them on.
 */

import crypto from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Language, Parser, Query } from 'web-tree-sitter'
import type { Tree } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'
import { runMigrations } from '../core/db-migrations'
import { createRateLimitedYielder, yieldEvery } from '../core/yield'
import {
  codeSymbolKey,
  deleteStaleCodeSymbols,
  getCodeFileState,
  hasSearchableIndexRows,
  upsertCodeFileState,
  upsertCodeSymbol,
} from './code-fact-writer'
import { fileStem, stemAlreadyIndexed } from './file-stem-symbol'
import type { SqliteKbIndexer } from './sqlite-kb-index'

const require = createRequire(import.meta.url)

const SOURCE = 'tree-sitter'

/** Cap on stored symbol source text — a whole 5k-line class is not a retrieval unit. */
const SYMBOL_SOURCE_TEXT_MAX_CHARS = 1500

// ---------------------------------------------------------------------------
// Shared code-index types (single AST platform: tree-sitter for every language)
// ---------------------------------------------------------------------------

export interface CodeIndexStats {
  files: number
  symbols: number
  /** Structural relationships seen but deliberately not stored (no fact graph). */
  edges: number
  skipped: number
  errors: number
  /** `<relPath>@<name>` for every symbol this run wrote — drives stale reconciliation. */
  symbolKeys: Set<string>
}

export interface CodeIndexOptions {
  onProgress?: (stats: CodeIndexStats) => void
  yieldEveryFiles?: number
  /** Wall-clock yield so HTTP stays responsive during large AST index runs. */
  yieldEveryMs?: number
  candidateFiles?: string[]
}

export interface LanguageIndexer {
  indexProject(repoRoot: string, opts?: CodeIndexOptions): Promise<CodeIndexStats>
  close(): void
}

/** Drop symbols for files no longer in the repo. Call after a full index finishes.
 *  Scoped to `gitRepo` so re-indexing one repo never purges another repo's symbols. */
export function deleteStaleAstSymbols(
  symbolIndexer: SqliteKbIndexer,
  allSymbolKeys: Set<string>,
  gitRepo?: string
): number {
  return deleteStaleCodeSymbols(symbolIndexer, allSymbolKeys, gitRepo)
}

/** Human-readable kind label for a JS/TS declaration node (nicer fact text than raw grammar types). */
const JS_KIND_LABEL: Record<string, string> = {
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  function_declaration: 'function',
  generator_function_declaration: 'function',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  variable_declarator: 'variable',
  method_definition: 'method',
}

/**
 * Grammar node types for a function-shaped initializer (`const x = () => {}`,
 * `const x = function () {}`, `const x = function* () {}`). Used only for embedded
 * Vue/Svelte scripts — see the `isEmbeddedScript` pass in `indexProject`.
 */
const JS_FUNCTION_VALUE_TYPES = new Set([
  'arrow_function',
  'function_expression',
  'generator_function',
])

/**
 * Returns a concise string for simple literal initializers (numbers, strings, booleans,
 * short arithmetic/template expressions). Returns undefined for complex expressions —
 * so constant symbols only capture genuinely literal values.
 */
function extractSimpleInitializerText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (trimmed.length > 120) return undefined
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
  if (/^['"`]/.test(trimmed)) return trimmed.slice(0, 80)
  if (trimmed === 'true' || trimmed === 'false') return trimmed
  // Short expressions that look like formulas (operators but no calls/objects).
  if (trimmed.length <= 60 && /[\d]/.test(trimmed) && !/[({]/.test(trimmed)) return trimmed
  return undefined
}

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
  /** Grammar require-spec (e.g. `tree-sitter-go/tree-sitter-go.wasm`); resolved at load time. */
  wasmPath: string
  importQueries: string[]
  exportQueries: string[]
  // If true, only uppercase-initial names are considered "exported" (Go convention)
  goExportConvention: boolean
  /**
   * JS/TS-family enrichment: extract constant literal values, top-level non-exported
   * constants (`defined_in` facts), and `extends`/`implements` structural edges. These
   * use shared node-navigation (not per-grammar queries) so they work across ts/tsx/js/jsx.
   */
  jsFamily?: boolean
}

/**
 * Return the grammar's require-spec (e.g. `tree-sitter-go/tree-sitter-go.wasm`) WITHOUT
 * resolving it. Resolution is deferred to `Language.load` (indexing time) so merely
 * importing this module never touches the filesystem — otherwise every `kb` command would
 * eager-resolve ~20 grammars at startup and crash when they aren't co-located with the
 * bundle (e.g. the remote-mode client, which never indexes). See `resolveWasmPath`.
 */
function resolveWasm(pkg: string, file: string): string {
  return `${pkg}/${file}`
}

/** Resolve a grammar require-spec to an absolute path at use-time. */
function resolveWasmPath(spec: string): string {
  return require.resolve(spec)
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
    jsFamily: true,
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
    jsFamily: true,
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
    jsFamily: true,
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
    jsFamily: true,
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
    exportQueries: ['(class_selector (class_name) @name)', '(id_selector (id_name) @name)'],
    goExportConvention: false,
  },
  bash: {
    wasmPath: resolveWasm('tree-sitter-bash', 'tree-sitter-bash.wasm'),
    importQueries: ['(source_command (word) @path)'],
    exportQueries: ['(function_definition name: (word) @name)'],
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
  haskell: {
    wasmPath: resolveWasm('tree-sitter-haskell', 'tree-sitter-haskell.wasm'),
    // Module imports are logical (e.g. ShellCheck.AST), not relative paths — skip
    // IMPORTS_FILE edges; symbol extraction still covers functions/types/classes.
    importQueries: [],
    exportQueries: [
      '(function name: (variable) @name)',
      '(signature name: (variable) @name)',
      '(data_type name: (name) @name)',
      '(newtype name: (name) @name)',
      '(type_synomym name: (name) @name)',
      '(class name: (name) @name)',
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
  // Haskell
  '.hs': 'haskell',
  '.lhs': 'haskell',
}

/** File extensions with a WASM grammar in LANG_CONFIGS (leading dot). */
export const TREE_SITTER_AST_EXTENSIONS = new Set(Object.keys(EXT_MAP))

// Text/config extensions we index as plain file nodes (no AST, no symbols).
// Anything not in EXT_MAP or TEXT_EXTS is ignored entirely.
export const TREE_SITTER_TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.xml',
  '.scss',
  '.sass',
  '.less',
  '.fish',
  '.dockerfile',
  '.containerfile',
  '.graphql',
  '.gql',
  '.proto',
  '.sql',
  '.tf',
  '.hcl',
  // Build manifests declare the module graph, deps, and entrypoints, and are a
  // common target of "how do I build this" questions. Without them a repo's
  // build story is unanswerable from source: `ShellCheck.cabal` matched neither
  // EXT_MAP nor this list, so it was skipped outright.
  '.cabal',
  '.gradle',
  '.kts',
  '.gemspec',
  '.podspec',
  '.cmake',
  '.bazel',
  '.bzl',
  '.mk',
  '.nix',
  // Vue/Svelte fall back to text-state here only when their inline <script> block can't be
  // extracted or parsed (see EMBEDDED_SCRIPT_EXTENSIONS) — the normal case is AST symbols.
  '.vue',
  '.svelte',
  // Astro templates remain text-indexed (no embedded-script extraction wired up).
  '.astro',
  // Svelte typo alias (legacy support, text-indexed)
  '.svlete',
  '', // extensionless files (Makefile, Dockerfile, etc.)
])

export const TREE_SITTER_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.tox',
  'venv',
  '.venv',
  // Generated / mirrored docs — not source-of-truth for retrieval
  '_site',
  '_original_docs',
  '_autogenerated_docs',
  '_data',
  '_graph_pages',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    try {
      st = statSync(full)
    } catch {
      continue
    }
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

/**
 * Extensions whose inline <script> blocks get re-parsed through the JS/TS grammar (see
 * `extractEmbeddedScript`). Falls back to plain text-state indexing when no inline script
 * block is found or the extracted code fails to parse.
 */
const EMBEDDED_SCRIPT_EXTENSIONS = new Set(['.vue', '.svelte'])

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/**
 * Extracts and concatenates inline (non-`src=`) <script> block bodies from a .vue/.svelte
 * file so they can be re-parsed through the existing JS/TS extraction pipeline. Multiple
 * blocks (Vue's `setup` + plain, Svelte's `context="module"` + instance) are concatenated;
 * TypeScript is picked whenever any block declares `lang="ts"`, since the TS grammar parses
 * plain JS too. Returns null when there is no inline script to parse.
 */
function extractEmbeddedScript(src: string): { code: string; lang: 'ts' | 'js' } | null {
  const parts: string[] = []
  let lang: 'ts' | 'js' = 'js'
  for (const match of src.matchAll(SCRIPT_BLOCK_RE)) {
    const attrs = match[1] ?? ''
    if (/\bsrc\s*=/.test(attrs)) continue
    const langAttr = /\blang\s*=\s*["']?(\w+)["']?/i.exec(attrs)?.[1]?.toLowerCase()
    if (langAttr === 'ts' || langAttr === 'typescript') lang = 'ts'
    parts.push(match[2] ?? '')
  }
  if (parts.length === 0) return null
  return { code: parts.join('\n'), lang }
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
    private symbolIndexer: SqliteKbIndexer,
    /** Repo slug stamped onto every symbol; also scopes per-file symbol replacement. */
    private gitRepo?: string
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

    const stats: CodeIndexStats = {
      files: 0,
      symbols: 0,
      edges: 0,
      skipped: 0,
      errors: 0,
      symbolKeys: new Set(),
    }
    const yieldStride = opts.yieldEveryFiles ?? 10
    const maybeYieldByTime = createRateLimitedYielder(opts.yieldEveryMs ?? 50)
    const candidateFiles = opts.candidateFiles
      ?.map(file => file.replace(/\\/g, '/'))
      .filter(file => isTreeSitterIndexablePath(file))

    const indexFile = async (absPath: string) => {
      const rel = relPath(repoRoot, absPath)
      const ext = path.extname(rel).toLowerCase()
      const langKey = EXT_MAP[ext]
      const contentHash = hashFile(absPath)
      // Skip only when this exact content was already indexed by *this* extractor. Files left
      // behind by the legacy ts-morph extractor are re-indexed so their facts are rewritten in
      // the tree-sitter scheme (same source_refs, so no duplicates survive reconciliation).
      const existing = getCodeFileState(this.db, rel)
      // Skip only when content is unchanged *and* retrieval can already see the
      // file. Pre-#234 text-only indexes left code_file_state with zero symbols;
      // those must re-enter the file-level symbol path on normal rescan.
      if (
        existing?.content_hash === contentHash &&
        contentHash !== '' &&
        existing.extractor === SOURCE &&
        hasSearchableIndexRows(this.db, rel)
      ) {
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

      // Text-only files — no AST, no symbols, just record state. .vue/.svelte get one shot at
      // an embedded-script extraction first; if that fails to find/load a grammar they fall
      // back to the same text-only path as everything else.
      let compiled = langKey ? this.langCache.get(langKey) : undefined
      let parseSrc = src
      // Set once an embedded <script> block is actually parsed — gates the export-free
      // symbol pass below, since only .vue/.svelte scripts lack module export syntax.
      let isEmbeddedScript = false
      if (!compiled && EMBEDDED_SCRIPT_EXTENSIONS.has(ext)) {
        const embedded = extractEmbeddedScript(src)
        if (embedded) {
          try {
            await this.ensureLang(embedded.lang)
            compiled = this.langCache.get(embedded.lang)
            parseSrc = embedded.code
            isEmbeddedScript = true
          } catch {
            compiled = undefined
          }
        }
      }
      if (!compiled) {
        // Text-only allowlist (.fish, .yaml, …): discovery already ran, but hybrid
        // retrieval only reads `code_symbols` / documents — a bare code_file_state
        // row is invisible. Emit one file-level symbol so path/content queries hit.
        await this.writeFileLevelSymbol(rel, src, stats)
        upsertCodeFileState(this.db, rel, contentHash, SOURCE)
        return
      }

      let tree: Tree | null
      const parser = this.parser as Parser
      try {
        parser.setLanguage(compiled.language)
        tree = parser.parse(parseSrc)
      } catch {
        // Parse failed — still emit a searchable file-level symbol so the path is
        // not invisible the way the old text-only state-only path was (#234).
        stats.errors++
        await this.writeFileLevelSymbol(rel, src, stats)
        upsertCodeFileState(this.db, rel, contentHash, SOURCE)
        return
      }
      if (tree == null) return

      try {
        const symbolsBefore = stats.symbols
        const wroteAnySymbol = () => stats.symbols > symbolsBefore
        await this.symbolIndexer.runInTransaction(() => {
          // Re-extracting a file replaces its symbols wholesale, so a renamed or deleted
          // export never lingers under the old name.
          this.symbolIndexer.deleteCodeSymbolsForFile(this.gitRepo ?? '', rel)

          // A single-file component's own name is nowhere in its script block: `Gantt.vue`
          // declares handlers and refs, never a `Gantt`. So the component is unaddressable by
          // the name everyone actually calls it, while a Java class gets its class name for
          // free. Measured on `eval-kestra` Q7 ("the UI execution Gantt/logs views"): `Gantt`
          // resolved to nothing and `Logs` resolved to two backend `Logs.java` files, so
          // name-based lookup promoted the wrong `Logs` and the gold UI component dropped out
          // of the citation list entirely (#238).
          if (isEmbeddedScript) {
            const componentName = path.basename(rel, ext)
            if (componentName && !stats.symbolKeys.has(codeSymbolKey(rel, componentName))) {
              stats.symbolKeys.add(codeSymbolKey(rel, componentName))
              const capped =
                src.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                  ? `${src.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                  : src
              upsertCodeSymbol(
                this.symbolIndexer,
                rel,
                componentName,
                'component',
                `${rel}\n${capped}`,
                this.gitRepo
              )
              stats.symbols++
            }
          }

          // Import relationships still count toward `edges` for progress reporting, but the
          // flat doc/symbol index has nowhere to store a file→file edge.
          for (const q of compiled.importQueries) {
            for (const match of q.matches(tree.rootNode)) {
              const importPath = match.captures[0]?.node.text
              if (!importPath) continue
              if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue
              stats.edges++
            }
          }

          const jsFamily = compiled.config.jsFamily === true
          for (const q of compiled.exportQueries) {
            for (const match of q.matches(tree.rootNode)) {
              const capture = match.captures.find(c => c.name === 'name') ?? match.captures[0]
              const name = capture?.node.text
              if (!name || !capture) continue
              if (!isExported(name, compiled.config.goExportConvention)) continue
              const nameNode = capture.node
              const declNode = getDeclNode(nameNode)
              const rawText = parseSrc.slice(declNode.startIndex, declNode.endIndex)
              const sourceText =
                rawText.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                  ? `${rawText.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                  : rawText
              stats.symbolKeys.add(codeSymbolKey(rel, name))

              // Readable kind label for JS/TS (from the declaration node), falling back to the
              // raw grammar node type for other languages.
              const declParent = nameNode.parent
              const kind =
                jsFamily && declParent
                  ? (JS_KIND_LABEL[declParent.type] ?? declParent.type)
                  : nameNode.type

              upsertCodeSymbol(this.symbolIndexer, rel, name, kind, sourceText, this.gitRepo)
              stats.symbols++
            }
          }

          // Top-level non-exported constants with literal values are still worth indexing —
          // they are how configuration defaults are discovered.
          //
          // Embedded Vue/Svelte scripts (`<script setup>`) get a second, wider pass below:
          // that block has no `export` syntax at all — everything declared at its top level is
          // implicitly the component's public surface, read directly by the template — so every
          // `exportQueries` match above is structurally guaranteed to be empty for it. Without
          // this, an entire SFC's handlers (`const onSubmit = () => {...}`) are invisible to
          // symbol search even though tree-sitter parsed them fine. Gated on `isEmbeddedScript`
          // only: an ordinary .ts/.js module has a real private/public split, and capturing every
          // unexported helper there would flood the symbol graph with implementation detail.
          if (jsFamily) {
            for (const node of tree.rootNode.namedChildren) {
              if (isEmbeddedScript && node?.type === 'function_declaration') {
                const fnName = node.childForFieldName('name')?.text
                if (fnName && !stats.symbolKeys.has(codeSymbolKey(rel, fnName))) {
                  stats.symbolKeys.add(codeSymbolKey(rel, fnName))
                  const rawText = parseSrc.slice(node.startIndex, node.endIndex)
                  upsertCodeSymbol(
                    this.symbolIndexer,
                    rel,
                    fnName,
                    'function',
                    rawText.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                      ? `${rawText.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                      : rawText,
                    this.gitRepo
                  )
                  stats.symbols++
                }
                continue
              }

              if (node?.type !== 'lexical_declaration') continue
              if (node.firstChild?.text !== 'const') continue
              for (const decl of node.namedChildren) {
                if (decl?.type !== 'variable_declarator') continue
                const constName = decl.childForFieldName('name')?.text
                if (!constName) continue
                if (stats.symbolKeys.has(codeSymbolKey(rel, constName))) continue

                const valueNode = decl.childForFieldName('value')
                if (isEmbeddedScript && valueNode && JS_FUNCTION_VALUE_TYPES.has(valueNode.type)) {
                  stats.symbolKeys.add(codeSymbolKey(rel, constName))
                  const rawText = decl.text
                  upsertCodeSymbol(
                    this.symbolIndexer,
                    rel,
                    constName,
                    'function',
                    rawText.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                      ? `${rawText.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                      : rawText,
                    this.gitRepo
                  )
                  stats.symbols++
                  continue
                }

                const valueText = extractSimpleInitializerText(valueNode?.text)
                if (!valueText) continue
                stats.symbolKeys.add(codeSymbolKey(rel, constName))
                upsertCodeSymbol(
                  this.symbolIndexer,
                  rel,
                  constName,
                  'constant',
                  decl.text,
                  this.gitRepo
                )
                stats.symbols++
              }
            }
          }

          // A file can parse cleanly and still export nothing the queries
          // capture — `test/shellcheck.hs` is `module Main where` with a bare
          // `main`, so shellcheck's entire test entrypoint produced zero rows
          // and was invisible to retrieval. Parse *failure* already falls back
          // to a file-level symbol; parse-success-with-no-symbols did not, which
          // is the same #234 invisibility by a different route.
          if (!wroteAnySymbol()) {
            const basename = path.basename(rel)
            const capped =
              src.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                ? `${src.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                : src
            upsertCodeSymbol(
              this.symbolIndexer,
              rel,
              basename,
              'file',
              `${rel}\n${capped}`,
              this.gitRepo
            )
            stats.symbolKeys.add(codeSymbolKey(rel, basename))
            stats.symbols++
          }

          // Conditional filename-stem symbol: only when no existing symbol already
          // matches the stem / PascalCase / camelCase. Generalizes the SFC fix
          // (`Gantt.vue` → `Gantt`) to kebab-case modules like `scope-inference.ts`.
          const stem = fileStem(rel)
          if (stem) {
            const prefix = `${rel}@`
            const namesOnFile: string[] = []
            for (const key of stats.symbolKeys) {
              if (key.startsWith(prefix)) namesOnFile.push(key.slice(prefix.length))
            }
            if (!stemAlreadyIndexed(stem, namesOnFile)) {
              const capped =
                src.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
                  ? `${src.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
                  : src
              stats.symbolKeys.add(codeSymbolKey(rel, stem))
              upsertCodeSymbol(
                this.symbolIndexer,
                rel,
                stem,
                'file',
                `${rel}\n${capped}`,
                this.gitRepo
              )
              stats.symbols++
            }
          }
        })
        upsertCodeFileState(this.db, rel, contentHash, SOURCE)
      } finally {
        tree.delete()
      }
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
      await maybeYieldByTime()
    }

    return stats
  }

  /** One searchable `kind=file` symbol so text-only / parse-fail paths are hybrid-visible. */
  private async writeFileLevelSymbol(
    rel: string,
    src: string,
    stats: CodeIndexStats
  ): Promise<void> {
    const basename = path.basename(rel)
    const capped =
      src.length > SYMBOL_SOURCE_TEXT_MAX_CHARS
        ? `${src.slice(0, SYMBOL_SOURCE_TEXT_MAX_CHARS - 3)}…`
        : src
    const sourceText = `${rel}\n${capped}`
    await this.symbolIndexer.runInTransaction(() => {
      this.symbolIndexer.deleteCodeSymbolsForFile(this.gitRepo ?? '', rel)
      upsertCodeSymbol(this.symbolIndexer, rel, basename, 'file', sourceText, this.gitRepo)
      stats.symbolKeys.add(codeSymbolKey(rel, basename))
      stats.symbols++
    })
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
    const language = await Language.load(resolveWasmPath(config.wasmPath))
    const compiled: CompiledLang = {
      language,
      importQueries: config.importQueries.map(s => new Query(language, s)),
      exportQueries: config.exportQueries.map(s => new Query(language, s)),
      config,
    }
    this.langCache.set(key, compiled)
  }
}
