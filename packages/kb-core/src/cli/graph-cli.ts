/**
 * kb graph — CLI for the doc↔code map (the post–fact-graph surface).
 *
 * Usage:
 *   kb graph                        Summary (documents, symbols, links)
 *   kb graph --entity <name>        Matching documents + symbols
 *   kb graph --file <relPath>       Index coverage for one source path
 *   kb graph --format json          Export the map as JSON
 *   kb graph --format dot           Export the map as DOT
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'

export interface GraphCommandOptions {
  entity?: string
  /** Repo-relative path — report whether the index has searchable rows for it. */
  file?: string
  pathFrom?: string
  pathTo?: string
  format?: 'dot' | 'json'
}

export class GraphCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message)
    this.name = 'GraphCommandError'
  }
}

export function printGraphHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('graph', mode)} commands`,
    '',
    'Global option (all subcommands):',
    `  ${cmd('[--base <name>]', mode)}   Session KB to inspect (defaults to active base)`,
    '',
    'Inspect:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity <name>', mode)}`,
    `  ${cmd('graph --file <relPath>', mode)}`,
    `  ${cmd('graph --format dot|json', mode)}`,
    '',
    'Notes:',
    '  Surfaces the document ↔ code-symbol map (flat links, no edge traversal).',
    `  ${cmd('graph --file', mode)} reports index coverage for one source path`,
    '  (code_file_state / code_symbols / documents) and exits non-zero when the',
    '  file has state but no searchable rows.',
    '',
    'Examples:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity "SqliteKbIndexer"', mode)}`,
    `  ${cmd('graph --file share/completions/scp.fish', mode)}`,
    `  ${cmd('graph --format json', mode)}`,
    `  ${cmd('graph --base dogfood --entity KB', mode)}`,
  ].join('\n')
}

export function parseGraphCommand(args: string[], mode: CmdMode = 'cli'): GraphCommandOptions {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    throw new GraphCommandError(printGraphHelp(mode), 0)
  }

  const opts: GraphCommandOptions = {}

  const entityIndex = args.indexOf('--entity')
  if (entityIndex !== -1 && args[entityIndex + 1]) {
    opts.entity = args[entityIndex + 1]
  }

  const fileIndex = args.indexOf('--file')
  if (fileIndex !== -1 && args[fileIndex + 1]) {
    opts.file = args[fileIndex + 1]
  }

  const pathIndex = args.indexOf('--path')
  if (pathIndex !== -1 && args[pathIndex + 1] && args[pathIndex + 2]) {
    opts.pathFrom = args[pathIndex + 1]
    opts.pathTo = args[pathIndex + 2]
  }

  const formatIndex = args.indexOf('--format')
  if (formatIndex !== -1) {
    const fmt = args[formatIndex + 1]
    if (fmt === 'dot' || fmt === 'json') {
      opts.format = fmt
    }
  }

  return opts
}

export interface GraphOut {
  log(message: string): void
}

const defaultGraphOut: GraphOut = { log: console.log }

function countTable(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

/**
 * Index-coverage audit for one repo-relative path (#234). Reports whether
 * `code_file_state`, `code_symbols`, and `documents` have rows for the path.
 * Exits non-zero when state exists but nothing searchable was written — the
 * text-only indexer trap that left `.fish` invisible to hybrid retrieval.
 */
function reportFileCoverage(db: DatabaseSync, rawPath: string, out: GraphOut): void {
  const rel = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const hasState =
    db.prepare('SELECT 1 AS n FROM code_file_state WHERE file_path = ?').get(rel) !== undefined
  const symbols = db
    .prepare('SELECT name, kind FROM code_symbols WHERE rel_path = ? ORDER BY name')
    .all(rel) as Array<{ name: string; kind: string }>
  const hasDocument =
    db.prepare('SELECT 1 AS n FROM documents WHERE rel_path = ?').get(rel) !== undefined

  out.log(`Coverage for ${rel}:`)
  out.log(`  code_file_state: ${hasState ? 'yes' : 'no'}`)
  out.log(`  code_symbols:    ${symbols.length}`)
  for (const row of symbols.slice(0, 20)) {
    out.log(`    ${row.name} (${row.kind})`)
  }
  if (symbols.length > 20) out.log(`    … +${symbols.length - 20} more`)
  out.log(`  documents:       ${hasDocument ? 'yes' : 'no'}`)

  const searchable = symbols.length > 0 || hasDocument
  if (!hasState && !searchable) {
    throw new GraphCommandError(
      `No index coverage for ${rel} — path unknown to code_file_state, code_symbols, and documents.`,
      1
    )
  }
  if (hasState && !searchable) {
    throw new GraphCommandError(
      `Indexed state exists for ${rel} but no searchable code_symbols/documents — re-index or check the text-only indexer path.`,
      1
    )
  }
}

export async function runGraphCommand(
  baseDir: string,
  opts: GraphCommandOptions,
  out: GraphOut = defaultGraphOut,
  _writerOverride?: unknown,
  _mode: CmdMode = 'cli'
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) {
    out.log('No KB index found. Run `kb init` to build the knowledge base.')
    return
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (opts.file) {
      reportFileCoverage(db, opts.file, out)
      return
    }

    if (opts.format === 'dot') {
      const rows = db
        .prepare(
          `SELECT d.rel_path AS doc_path, d.title, s.name AS symbol, s.rel_path AS code_path
           FROM doc_code_links l
           JOIN documents d ON d.id = l.doc_id
           JOIN code_symbols s ON s.id = l.symbol_id
           ORDER BY l.score DESC
           LIMIT 2000`
        )
        .all() as Array<{
        doc_path: string
        title: string
        symbol: string
        code_path: string
      }>

      const lines = ['digraph kb_doc_code {', '  rankdir=LR;']
      for (const row of rows) {
        const from = String(row.doc_path).replace(/"/g, '\\"')
        const to = `${row.symbol}@${row.code_path}`.replace(/"/g, '\\"')
        lines.push(`  "${from}" -> "${to}" [label="relates_to"];`)
      }
      lines.push('}')
      out.log(lines.join('\n'))
      return
    }

    if (opts.format === 'json') {
      const documents = db
        .prepare(
          'SELECT id, git_repo, rel_path, title FROM documents ORDER BY rel_path LIMIT 500'
        )
        .all()
      const symbols = db
        .prepare(
          'SELECT id, git_repo, rel_path, name, kind FROM code_symbols ORDER BY name LIMIT 500'
        )
        .all()
      const links = db
        .prepare(
          'SELECT doc_id, symbol_id, score, link_kind FROM doc_code_links ORDER BY score DESC LIMIT 2000'
        )
        .all()
      out.log(JSON.stringify({ documents, symbols, links }, null, 2))
      return
    }

    if (opts.pathFrom && opts.pathTo) {
      out.log(
        'Path search over a structural code graph is not available in v1 — docs and symbols are joined via flat links only. Try `kb graph --entity <name>`.'
      )
      return
    }

    if (opts.entity) {
      const pattern = `%${opts.entity.toLowerCase()}%`
      const docs = db
        .prepare(
          `SELECT rel_path, title, git_repo FROM documents
           WHERE lower(title) LIKE ? OR lower(rel_path) LIKE ? OR lower(body) LIKE ?
           LIMIT 50`
        )
        .all(pattern, pattern, pattern) as Array<{
        rel_path: string
        title: string
        git_repo: string
      }>
      const symbols = db
        .prepare(
          `SELECT name, kind, rel_path, git_repo FROM code_symbols
           WHERE lower(name) LIKE ? OR lower(rel_path) LIKE ?
           LIMIT 50`
        )
        .all(pattern, pattern) as Array<{
        name: string
        kind: string
        rel_path: string
        git_repo: string
      }>

      if (docs.length === 0 && symbols.length === 0) {
        out.log(`No documents or symbols matching "${opts.entity}".`)
        return
      }
      if (docs.length > 0) {
        out.log(`Documents matching "${opts.entity}":`)
        for (const row of docs) {
          const prefix = row.git_repo ? `${row.git_repo}/` : ''
          out.log(`  ${prefix}${row.rel_path} — ${row.title}`)
        }
      }
      if (symbols.length > 0) {
        if (docs.length > 0) out.log('')
        out.log(`Symbols matching "${opts.entity}":`)
        for (const row of symbols) {
          const prefix = row.git_repo ? `${row.git_repo}/` : ''
          out.log(`  ${row.name} (${row.kind}) — ${prefix}${row.rel_path}`)
        }
      }
      return
    }

    const documentCount = countTable(db, 'SELECT COUNT(*) AS n FROM documents')
    const symbolCount = countTable(db, 'SELECT COUNT(*) AS n FROM code_symbols')
    const linkCount = countTable(db, 'SELECT COUNT(*) AS n FROM doc_code_links')
    const factCount = countTable(
      db,
      'SELECT COUNT(*) AS n FROM facts WHERE tombstoned_at IS NULL'
    )

    const topSymbols = db
      .prepare(
        `SELECT s.name, COUNT(*) AS cnt
         FROM doc_code_links l
         JOIN code_symbols s ON s.id = l.symbol_id
         GROUP BY s.id
         ORDER BY cnt DESC
         LIMIT 10`
      )
      .all() as Array<{ name: string; cnt: number }>

    out.log('Doc ↔ code map summary')
    out.log(`  Documents: ${documentCount}`)
    out.log(`  Symbols:   ${symbolCount}`)
    out.log(`  Links:     ${linkCount}`)
    out.log(`  Facts:     ${factCount}`)
    if (topSymbols.length > 0) {
      out.log('')
      out.log('Most-linked symbols:')
      for (const row of topSymbols) {
        out.log(`  ${row.name} — ${row.cnt} link${row.cnt === 1 ? '' : 's'}`)
      }
    }
  } finally {
    db.close()
  }
}

/** Compact JSON for init / tooling. */
export interface KnowledgeGraphInitSummaryJson {
  entities: number
  relationships: number
  topEntities: Array<{ id: string; name: string; type: string; connections: number }>
}

/**
 * Read a doc↔code map summary from the index.
 * Returns null if the database file does not exist yet.
 */
export async function readKnowledgeGraphInitSummary(
  baseDir: string
): Promise<{ human: string; json: KnowledgeGraphInitSummaryJson } | null> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) return null

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const documentCount = countTable(db, 'SELECT COUNT(*) AS n FROM documents')
    const symbolCount = countTable(db, 'SELECT COUNT(*) AS n FROM code_symbols')
    const linkCount = countTable(db, 'SELECT COUNT(*) AS n FROM doc_code_links')

    const topSymbols = db
      .prepare(
        `SELECT s.name, COUNT(*) AS cnt
         FROM doc_code_links l
         JOIN code_symbols s ON s.id = l.symbol_id
         GROUP BY s.id
         ORDER BY cnt DESC
         LIMIT 10`
      )
      .all() as Array<{ name: string; cnt: number }>

    const human = [
      'Doc ↔ code map summary',
      `  Documents: ${documentCount}`,
      `  Symbols:   ${symbolCount}`,
      `  Links:     ${linkCount}`,
      ...(topSymbols.length > 0
        ? ['', 'Most-linked symbols:', ...topSymbols.map(r => `  ${r.name} — ${r.cnt}`)]
        : []),
    ].join('\n')

    const json: KnowledgeGraphInitSummaryJson = {
      entities: documentCount + symbolCount,
      relationships: linkCount,
      topEntities: topSymbols.map(r => ({
        id: r.name,
        name: r.name,
        type: 'symbol',
        connections: Number(r.cnt),
      })),
    }

    return { human, json }
  } finally {
    db.close()
  }
}
