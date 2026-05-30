/**
 * kb graph — CLI commands for the knowledge graph (facts-based).
 *
 * Usage:
 *   kb graph                        Summary (triplet count, symbol count, top subjects)
 *   kb graph --entity <name>        Matching triplets from facts
 *   kb graph --path <from> <to>     BFS path through facts triplets
 *   kb graph --format dot           Export from facts triplets as DOT graph
 *   kb graph --format json          Export from facts triplets as JSON
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findFactsPath } from '../tools/graph-relation-context'
import { type CmdMode, cmd } from './cmd-ref'

export interface GraphCommandOptions {
  entity?: string
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
    `  ${cmd('graph --path <from> <to>', mode)}`,
    `  ${cmd('graph --format dot|json', mode)}`,
    '',
    'Notes:',
    '  The graph is derived from the facts table (subject→predicate→object triplets).',
    '',
    'Examples:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity "KB"', mode)}`,
    `  ${cmd('graph --path "KB" "SQLite"', mode)}`,
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

// Minimal output interface — compatible with CliOutput from index.ts (duck-typed)
export interface GraphOut {
  log(message: string): void
}

const defaultGraphOut: GraphOut = { log: console.log }

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
    // --format dot
    if (opts.format === 'dot') {
      const rows = db
        .prepare(
          `SELECT subject, predicate, object FROM facts
           WHERE tombstoned_at IS NULL AND predicate != 'asserts' AND subject != 'kb'
           LIMIT 2000`
        )
        .all() as Array<{ subject: string; predicate: string; object: string }>

      const lines = ['digraph kb_graph {', '  rankdir=LR;']
      for (const row of rows) {
        const from = String(row.subject).replace(/"/g, '\\"')
        const rel = String(row.predicate)
        const to = String(row.object).replace(/"/g, '\\"')
        lines.push(`  "${from}" -> "${to}" [label="${rel}"];`)
      }
      lines.push('}')
      out.log(lines.join('\n'))
      return
    }

    // --format json
    if (opts.format === 'json') {
      const entities = db
        .prepare(
          `SELECT DISTINCT subject AS id, subject AS name FROM facts
           WHERE tombstoned_at IS NULL AND subject != 'kb' AND predicate != 'asserts'
           LIMIT 500`
        )
        .all()
      const relationships = db
        .prepare(
          `SELECT subject AS fromId, predicate AS type, object AS toId FROM facts
           WHERE tombstoned_at IS NULL AND predicate != 'asserts' AND subject != 'kb'
           LIMIT 2000`
        )
        .all()
      out.log(JSON.stringify({ entities, relationships }, null, 2))
      return
    }

    // --path <from> <to>
    if (opts.pathFrom && opts.pathTo) {
      const result = findFactsPath(db, opts.pathFrom, opts.pathTo)
      if (!result) {
        out.log(`No path found between "${opts.pathFrom}" and "${opts.pathTo}".`)
      } else {
        const hops = result.edgeLabels.length
        out.log(`Path (${hops} hop${hops === 1 ? '' : 's'}):`)
        out.log(`  ${result.nodes.join(' → ')}`)
      }
      return
    }

    // --entity <name>
    if (opts.entity) {
      const pattern = `%${opts.entity.toLowerCase()}%`
      const rows = db
        .prepare(
          `SELECT subject, predicate, object FROM facts
           WHERE tombstoned_at IS NULL
             AND predicate != 'asserts'
             AND subject != 'kb'
             AND (LOWER(subject) LIKE ? OR LOWER(object) LIKE ?)
           LIMIT 100`
        )
        .all(pattern, pattern) as Array<{ subject: string; predicate: string; object: string }>

      if (rows.length === 0) {
        out.log(`No facts found matching "${opts.entity}".`)
        return
      }
      out.log(`Facts matching "${opts.entity}":`)
      for (const row of rows) {
        out.log(`  ${row.subject} -[${row.predicate}]-> ${row.object}`)
      }
      return
    }

    // Default: summary
    const tripletCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts
           WHERE predicate != 'asserts' AND tombstoned_at IS NULL AND subject != 'kb'`
        )
        .get() as { n: number }
    ).n

    const symbolCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts
           WHERE source_kind = 'import_code' AND predicate = 'exported_from' AND tombstoned_at IS NULL`
        )
        .get() as { n: number }
    ).n

    const topSubjects = db
      .prepare(
        `SELECT subject, COUNT(*) AS cnt FROM facts
         WHERE tombstoned_at IS NULL AND predicate != 'asserts' AND subject != 'kb'
         GROUP BY subject ORDER BY cnt DESC LIMIT 10`
      )
      .all() as Array<{ subject: string; cnt: number }>

    out.log('Knowledge graph summary')
    out.log(`  Triplets: ${tripletCount}`)
    out.log(`  Symbols:  ${symbolCount}`)
    if (topSubjects.length > 0) {
      out.log('')
      out.log('Top subjects by frequency:')
      for (const row of topSubjects) {
        out.log(`  ${row.subject} — ${row.cnt} fact${row.cnt === 1 ? '' : 's'}`)
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
 * Read a graph summary from the facts table.
 * Returns null if the database file does not exist yet.
 */
export async function readKnowledgeGraphInitSummary(
  baseDir: string
): Promise<{ human: string; json: KnowledgeGraphInitSummaryJson } | null> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) return null

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tripletCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts
           WHERE predicate != 'asserts' AND tombstoned_at IS NULL AND subject != 'kb'`
        )
        .get() as { n: number }
    ).n

    const symbolCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts
           WHERE source_kind = 'import_code' AND predicate = 'exported_from' AND tombstoned_at IS NULL`
        )
        .get() as { n: number }
    ).n

    const topSubjects = db
      .prepare(
        `SELECT subject, COUNT(*) AS cnt FROM facts
         WHERE tombstoned_at IS NULL AND predicate != 'asserts' AND subject != 'kb'
         GROUP BY subject ORDER BY cnt DESC LIMIT 10`
      )
      .all() as Array<{ subject: string; cnt: number }>

    const human = [
      'Knowledge graph summary',
      `  Triplets: ${tripletCount}`,
      `  Symbols:  ${symbolCount}`,
      ...(topSubjects.length > 0
        ? ['', 'Top subjects by frequency:', ...topSubjects.map(r => `  ${r.subject} — ${r.cnt}`)]
        : []),
    ].join('\n')

    const json: KnowledgeGraphInitSummaryJson = {
      entities: tripletCount,
      relationships: tripletCount,
      topEntities: topSubjects.map(r => ({
        id: r.subject,
        name: r.subject,
        type: 'concept',
        connections: Number(r.cnt),
      })),
    }

    return { human, json }
  } finally {
    db.close()
  }
}
