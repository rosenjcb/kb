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

import { DuckGraphWriter } from '../tools/duck-graph-writer'

export interface GraphCommandOptions {
  entity?: string
  pathFrom?: string
  pathTo?: string
  format?: 'dot' | 'json'
}

export class GraphCommandError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message)
    this.name = 'GraphCommandError'
  }
}

export function printGraphHelp(): string {
  return [
    'kb graph commands',
    '',
    'Usage:',
    '  kb graph',
    '  kb graph --entity <name>',
    '  kb graph --path <from> <to>',
    '  kb graph --format dot|json',
    '',
    'Examples:',
    '  kb graph',
    '  kb graph --entity "KB"',
    '  kb graph --path "KB" "SQLite"',
    '  kb graph --format json',
  ].join('\n')
}

export function parseGraphCommand(args: string[]): GraphCommandOptions {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    throw new GraphCommandError(printGraphHelp(), 0)
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

export async function runGraphCommand(baseDir: string, opts: GraphCommandOptions): Promise<void> {
  const graphPath = DuckGraphWriter.dbPathForBase(baseDir)
  const writer = new DuckGraphWriter(graphPath)

  try {
    await writer.open()

    // --format dot
    if (opts.format === 'dot') {
      console.log(await writer.exportDot())
      return
    }

    // --format json
    if (opts.format === 'json') {
      console.log(JSON.stringify(await writer.exportJson(), null, 2))
      return
    }

    // --path <from> <to>
    if (opts.pathFrom && opts.pathTo) {
      const result = await writer.findPath(opts.pathFrom, opts.pathTo)
      if (!result) {
        console.log(`No path found between "${opts.pathFrom}" and "${opts.pathTo}".`)
      } else {
        console.log(`Path (${result.hops} hop${result.hops === 1 ? '' : 's'}):`)
        console.log(`  ${result.nodes.join(' → ')}`)
      }
      return
    }

    // --entity <name>
    if (opts.entity) {
      const result = await writer.getNeighbors(opts.entity)
      if (!result) {
        console.log(`Entity "${opts.entity}" not found in the graph.`)
        return
      }
      console.log(`Entity: ${result.entity.name} [${result.entity.type}]`)
      if (result.outgoing.length > 0) {
        console.log('\nOutgoing:')
        for (const edge of result.outgoing) {
          console.log(`  -[${edge.rel}]→ ${edge.target.name} [${edge.target.type}]`)
        }
      }
      if (result.incoming.length > 0) {
        console.log('\nIncoming:')
        for (const edge of result.incoming) {
          console.log(`  ←[${edge.rel}]- ${edge.source.name} [${edge.source.type}]`)
        }
      }
      if (result.outgoing.length === 0 && result.incoming.length === 0) {
        console.log('(no connections)')
      }
      return
    }

    // Default: summary
    const summary = await writer.getSummary()
    console.log(`Knowledge graph summary`)
    console.log(`  Entities:      ${summary.totalEntities}`)
    console.log(`  Relationships: ${summary.totalRelationships}`)
    if (summary.topEntities.length > 0) {
      console.log('\nTop entities by connections:')
      for (const e of summary.topEntities.slice(0, 10)) {
        console.log(`  ${e.name} [${e.type}] — ${e.connections} connection${e.connections === 1 ? '' : 's'}`)
      }
    }
  } finally {
    writer.close()
  }
}
