/**
 * kb graph — CLI commands for the knowledge graph.
 *
 * Usage:
 *   kb graph                        Summary (entity + relationship counts, top nodes)
 *   kb graph --entity <name>        Neighbours of a named entity
 *   kb graph --path <from> <to>     Shortest path between two entities
 *   kb graph --format dot           Export full graph as Graphviz DOT
 *   kb graph --format json          Export full graph as JSON
 */

import { existsSync } from 'node:fs'
import { DuckGraphWriter, type GraphSummary } from '../tools/duck-graph-writer'
import { type CmdMode, cmd } from './cmd-ref'

export interface GraphCommandOptions {
  entity?: string
  pathFrom?: string
  pathTo?: string
  format?: 'dot' | 'json'
}

/** Compact JSON for init / tooling (counts + top nodes by degree, not full `exportJson`). */
export interface KnowledgeGraphInitSummaryJson {
  entities: number
  relationships: number
  topEntities: Array<{ id: string; name: string; type: string; connections: number }>
}

export function formatKnowledgeGraphHumanSummary(summary: GraphSummary): string {
  const lines: string[] = [
    'Knowledge graph summary',
    `  Entities:      ${summary.totalEntities}`,
    `  Relationships: ${summary.totalRelationships}`,
  ]
  if (summary.topEntities.length > 0) {
    lines.push('')
    lines.push('Top entities by connections:')
    for (const e of summary.topEntities.slice(0, 10)) {
      lines.push(
        `  ${e.name} [${e.type}] — ${e.connections} connection${e.connections === 1 ? '' : 's'}`
      )
    }
  }
  return lines.join('\n')
}

/**
 * Read the same summary `kb graph` prints, plus a small JSON object (subset of `kb graph --format json`).
 * Returns null if the graph database file does not exist yet.
 */
export async function readKnowledgeGraphInitSummary(
  baseDir: string
): Promise<{ human: string; json: KnowledgeGraphInitSummaryJson } | null> {
  const dbPath = DuckGraphWriter.dbPathForBase(baseDir)
  if (!existsSync(dbPath)) return null

  const writer = new DuckGraphWriter(dbPath)
  try {
    await writer.open()
    const summary = await writer.getSummary()
    const json: KnowledgeGraphInitSummaryJson = {
      entities: summary.totalEntities,
      relationships: summary.totalRelationships,
      topEntities: summary.topEntities.slice(0, 10).map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        connections: e.connections,
      })),
    }
    return { human: formatKnowledgeGraphHumanSummary(summary), json }
  } finally {
    await writer.close()
  }
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
    'Usage:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity <name>', mode)}`,
    `  ${cmd('graph --path <from> <to>', mode)}`,
    `  ${cmd('graph --format dot|json', mode)}`,
    '',
    'Examples:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity "KB"', mode)}`,
    `  ${cmd('graph --path "KB" "SQLite"', mode)}`,
    `  ${cmd('graph --format json', mode)}`,
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

// Minimal writer interface used by runGraphCommand — lets tests inject a stub
export interface GraphWriter {
  open(): Promise<void>
  close(): Promise<void>
  getSummary(): Promise<GraphSummary>
  exportDot(): Promise<string>
  exportJson(): Promise<unknown>
  findPath(from: string, to: string): Promise<{ hops: number; nodes: string[] } | null>
  getNeighbors(entity: string): Promise<{
    entity: { name: string; type: string }
    outgoing: Array<{ rel: string; target: { name: string; type: string } }>
    incoming: Array<{ rel: string; source: { name: string; type: string } }>
  } | null>
}

const defaultGraphOut: GraphOut = { log: console.log }

export async function runGraphCommand(
  baseDir: string,
  opts: GraphCommandOptions,
  out: GraphOut = defaultGraphOut,
  writerOverride?: GraphWriter
): Promise<void> {
  const writer: GraphWriter =
    writerOverride ?? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(baseDir))

  try {
    await writer.open()

    // --format dot
    if (opts.format === 'dot') {
      out.log(await writer.exportDot())
      return
    }

    // --format json
    if (opts.format === 'json') {
      out.log(JSON.stringify(await writer.exportJson(), null, 2))
      return
    }

    // --path <from> <to>
    if (opts.pathFrom && opts.pathTo) {
      const result = await writer.findPath(opts.pathFrom, opts.pathTo)
      if (!result) {
        out.log(`No path found between "${opts.pathFrom}" and "${opts.pathTo}".`)
      } else {
        out.log(`Path (${result.hops} hop${result.hops === 1 ? '' : 's'}):`)
        out.log(`  ${result.nodes.join(' → ')}`)
      }
      return
    }

    // --entity <name>
    if (opts.entity) {
      const result = await writer.getNeighbors(opts.entity)
      if (!result) {
        out.log(`Entity "${opts.entity}" not found in the graph.`)
        return
      }
      out.log(`Entity: ${result.entity.name} [${result.entity.type}]`)
      if (result.outgoing.length > 0) {
        out.log('\nOutgoing:')
        for (const edge of result.outgoing) {
          out.log(`  -[${edge.rel}]→ ${edge.target.name} [${edge.target.type}]`)
        }
      }
      if (result.incoming.length > 0) {
        out.log('\nIncoming:')
        for (const edge of result.incoming) {
          out.log(`  ←[${edge.rel}]- ${edge.source.name} [${edge.source.type}]`)
        }
      }
      if (result.outgoing.length === 0 && result.incoming.length === 0) {
        out.log('(no connections)')
      }
      return
    }

    // Default: summary
    const summary = await writer.getSummary()
    for (const line of formatKnowledgeGraphHumanSummary(summary).split('\n')) {
      out.log(line)
    }
  } finally {
    await writer.close()
  }
}
