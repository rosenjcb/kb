/**
 * AST Structural Loss (L_AST)
 *
 * Computes Jaccard distance between the exported-symbol node sets of two code
 * snippets parsed by the same tree-sitter grammar.  A score of 0 means the two
 * snippets expose identical named declarations; 1 means no overlap at all.
 *
 * Initialization pattern mirrors src/tools/tree-sitter-indexer.ts exactly:
 *   1. Parser.init() — static, async, call once
 *   2. new Parser()  — create the shared parser instance
 *   3. Language.load(wasmPath) — per-language, cached in AstLossParser
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser, Language, Query } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'

const kbCoreRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/kb-core/package.json'),
)

function resolveWasm(pkg: string, file: string): string {
  return kbCoreRequire.resolve(`${pkg}/${file}`)
}

// Export queries copied from LANG_CONFIGS in src/tools/tree-sitter-indexer.ts.
// Only the exportQueries are needed here — importQueries are irrelevant for structural loss.
const LANG_WASM: Record<string, { wasmPath: string; exportQueries: string[] }> = {
  ts: {
    wasmPath: resolveWasm('tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
      '(export_statement declaration: (interface_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (type_alias_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (enum_declaration name: (identifier) @name))',
    ],
  },
  tsx: {
    wasmPath: resolveWasm('tree-sitter-typescript', 'tree-sitter-tsx.wasm'),
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
      '(export_statement declaration: (interface_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (type_alias_declaration name: (type_identifier) @name))',
      '(export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))',
    ],
  },
  python: {
    wasmPath: resolveWasm('tree-sitter-python', 'tree-sitter-python.wasm'),
    exportQueries: [
      '(function_definition name: (identifier) @name)',
      '(class_definition name: (identifier) @name)',
    ],
  },
  js: {
    wasmPath: resolveWasm('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
    ],
  },
  jsx: {
    wasmPath: resolveWasm('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
    exportQueries: [
      '(export_statement declaration: (class_declaration name: (identifier) @name))',
      '(export_statement declaration: (function_declaration name: (identifier) @name))',
      '(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))',
    ],
  },
  go: {
    wasmPath: resolveWasm('tree-sitter-go', 'tree-sitter-go.wasm'),
    exportQueries: [
      '(function_declaration name: (identifier) @name)',
      '(method_declaration name: (field_identifier) @name)',
      '(type_declaration (type_spec name: (type_identifier) @name))',
      '(var_declaration (var_spec name: (identifier) @name))',
      '(const_declaration (const_spec name: (identifier) @name))',
    ],
  },
  rust: {
    wasmPath: resolveWasm('tree-sitter-rust', 'tree-sitter-rust.wasm'),
    exportQueries: [
      '(function_item name: (identifier) @name)',
      '(struct_item name: (type_identifier) @name)',
      '(enum_item name: (type_identifier) @name)',
      '(trait_item name: (type_identifier) @name)',
      '(type_item name: (type_identifier) @name)',
      '(const_item name: (identifier) @name)',
      '(mod_item name: (identifier) @name)',
    ],
  },
}

export interface AstLossParser {
  parser: Parser
  langCache: Map<string, Language>
  queryCache: Map<string, Query[]>
}

/** Call once before using computeAstLoss. Initializes the WASM runtime. */
export async function initAstLossParser(): Promise<AstLossParser> {
  await Parser.init()
  const parser = new Parser()
  return { parser, langCache: new Map(), queryCache: new Map() }
}

async function ensureLang(ctx: AstLossParser, language: string): Promise<Language> {
  const cached = ctx.langCache.get(language)
  if (cached) return cached
  const config = LANG_WASM[language]
  if (!config) throw new Error(`Unsupported language for AST loss: ${language}`)
  const lang = await Language.load(config.wasmPath)
  ctx.langCache.set(language, lang)
  ctx.queryCache.set(language, config.exportQueries.map(q => new Query(lang, q)))
  return lang
}

// For TS/JS snippets without existing exports, prepend a bare module marker so
// export_statement queries can fire against top-level declarations.
function wrapSnippet(src: string, language: string): string {
  if (language === 'ts' || language === 'tsx' || language === 'js' || language === 'jsx') {
    return `export {};\n${src}`
  }
  if (language === 'go' && !src.trimStart().startsWith('package ')) {
    return `package main\n${src}`
  }
  return src
}

function extractNodeSet(rootNode: TsNode, queries: Query[]): Set<string> {
  const nodes = new Set<string>()
  for (const query of queries) {
    for (const match of query.matches(rootNode)) {
      const capture = match.captures.find(c => c.name === 'name') ?? match.captures[0]
      if (!capture) continue
      const nameText = capture.node.text
      // Use the immediate parent declaration type as the key prefix so that
      // renames and type changes both register as differences.
      const declType = capture.node.parent?.type ?? capture.node.type
      if (nameText) nodes.add(`${declType}:${nameText}`)
    }
  }
  return nodes
}

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  const intersection = [...a].filter(x => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return 1 - intersection / union
}

/**
 * Returns Jaccard structural distance between candidate and reference, in [0, 1].
 * 0 = structurally identical exported declarations.
 * 1 = no shared declarations (or unsupported language / parse failure).
 *
 * ctx must be obtained from initAstLossParser() and reused across calls.
 */
export async function computeAstLoss(
  candidate: string,
  reference: string,
  language: string,
  ctx: AstLossParser
): Promise<number> {
  let lang: Language
  try {
    lang = await ensureLang(ctx, language)
  } catch {
    return 1.0
  }

  const queries = ctx.queryCache.get(language) ?? []
  ctx.parser.setLanguage(lang)

  let candidateTree: Parser.Tree | null
  let referenceTree: Parser.Tree | null
  try {
    candidateTree = ctx.parser.parse(wrapSnippet(candidate, language))
    referenceTree = ctx.parser.parse(wrapSnippet(reference, language))
  } catch {
    return 1.0
  }

  if (!candidateTree || !referenceTree) return 1.0

  const candidateNodes = extractNodeSet(candidateTree.rootNode, queries)
  const referenceNodes = extractNodeSet(referenceTree.rootNode, queries)

  return jaccardDistance(candidateNodes, referenceNodes)
}
