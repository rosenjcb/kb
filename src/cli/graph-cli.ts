/**
 * kb graph — CLI commands for the knowledge graph.
 *
 * Usage:
 *   kb graph                        Summary (entity + relationship counts, top nodes)
 *   kb graph --entity <name>        Neighbours of a named entity
 *   kb graph --path <from> <to>     Shortest path between two entities
 *   kb graph --format dot           Export full graph as Graphviz DOT
 *   kb graph --format json          Export full graph as JSON
 *   kb graph node add ... [--apply] Create / upsert an entity (dry-run without --apply)
 *   kb graph node set ... [--apply] Update name, description, or type
 *   kb graph edge add ... [--apply] Add a directed edge (--verb is the relationship label)
 *   kb graph edge remove ... [--apply] Soft-delete a directed edge
 */

import { existsSync } from 'node:fs'
import {
  DuckGraphWriter,
  type EntityType,
  type GraphSummary,
  kbGraphEntityIdKey,
} from '../tools/duck-graph-writer'
import { type CmdMode, cmd } from './cmd-ref'

const ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  'concept',
  'system',
  'tool',
  'decision',
  'person',
])

export type GraphMutationPlan =
  | {
      op: 'node-add'
      name: string
      id?: string
      entityType: EntityType
      description?: string
      docId?: string
      apply: boolean
    }
  | {
      op: 'node-set'
      target: string
      name?: string
      description?: string | null
      entityType?: EntityType
      apply: boolean
    }
  | {
      op: 'edge-add'
      fromRef: string
      toRef: string
      verb: string
      docId?: string
      apply: boolean
    }
  | {
      op: 'edge-remove'
      fromRef: string
      toRef: string
      verb: string
      apply: boolean
    }

export interface GraphCommandOptions {
  entity?: string
  pathFrom?: string
  pathTo?: string
  format?: 'dot' | 'json'
  mutation?: GraphMutationPlan
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
    'Global option (all subcommands):',
    `  ${cmd('[--base <name>]', mode)}   Session KB to inspect or edit (defaults to active base)`,
    '',
    'Inspect:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity <name>', mode)}`,
    `  ${cmd('graph --path <from> <to>', mode)}`,
    `  ${cmd('graph --format dot|json', mode)}`,
    '',
    'Edit (mutations are dry-run until you pass --apply):',
    `  ${cmd('graph node add --name "My API" [--id my-api] [--type tool] [--description "..."] [--doc-id <id>]', mode)}`,
    `  ${cmd('graph node set --entity <id-or-name> [--name "..."] [--description "..."] [--type concept]', mode)}`,
    `  ${cmd('graph edge add --from <id-or-name> --to <id-or-name> --verb uses [--doc-id <id>]', mode)}`,
    `  ${cmd('graph edge remove --from <id-or-name> --to <id-or-name> --verb uses', mode)}`,
    '',
    'Examples:',
    `  ${cmd('graph', mode)}`,
    `  ${cmd('graph --entity "KB"', mode)}`,
    `  ${cmd('graph --path "KB" "SQLite"', mode)}`,
    `  ${cmd('graph --format json', mode)}`,
    `  ${cmd('graph --base dogfood --entity KB', mode)}`,
    `  ${cmd('graph node add --name "Auth service" --type system --description "Owns tokens" --apply', mode)}`,
    `  ${cmd('graph edge add --from auth-service --to sqlite --verb persists_to --apply', mode)}`,
  ].join('\n')
}

function parseDoubleDashFlags(argv: string[]): { map: Record<string, string>; apply: boolean } {
  const map: Record<string, string> = {}
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--apply') {
      apply = true
      continue
    }
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      map[key] = next
      i++
    } else {
      map[key] = ''
    }
  }
  return { map, apply }
}

function parseEntityType(raw: string | undefined, mode: CmdMode): EntityType {
  if (!raw) return 'concept'
  const t = raw.trim().toLowerCase() as EntityType
  if (!ENTITY_TYPES.has(t)) {
    throw new GraphCommandError(
      `Invalid --type "${raw}". Use one of: ${[...ENTITY_TYPES].join(', ')}. Try ${cmd('graph --help', mode)}.`
    )
  }
  return t
}

function parseMutationPlan(args: string[], mode: CmdMode): GraphMutationPlan {
  if (args.length < 2) {
    throw new GraphCommandError(
      `Missing graph subcommand. Try ${cmd('graph --help', mode)} for node/edge editing.`
    )
  }

  const head = args[0]
  const sub = args[1]
  const tail = args.slice(2)
  const { map, apply } = parseDoubleDashFlags(tail)

  if (head === 'node' && sub === 'add') {
    const name = map.name?.trim()
    if (!name) {
      throw new GraphCommandError(
        `node add requires --name. Example: ${cmd('graph node add --name "My concept" --apply', mode)}`
      )
    }
    return {
      op: 'node-add',
      name,
      id: map.id?.trim() || undefined,
      entityType: parseEntityType(map.type, mode),
      description: map.description?.trim() || undefined,
      docId: map['doc-id']?.trim() || map.docId?.trim() || undefined,
      apply,
    }
  }

  if (head === 'node' && sub === 'set') {
    const target = map.entity?.trim() || map.id?.trim()
    if (!target) {
      throw new GraphCommandError(
        `node set requires --entity <id-or-name> (or --id). Example: ${cmd('graph node set --entity kb --description "..." --apply', mode)}`
      )
    }
    const hasPatch = !!(map.name || map.description !== undefined || map.type)
    if (!hasPatch) {
      throw new GraphCommandError(
        `node set needs at least one of: --name, --description, --type. Try ${cmd('graph --help', mode)}.`
      )
    }
    return {
      op: 'node-set',
      target,
      name: map.name?.trim() || undefined,
      description: map.description !== undefined ? map.description : undefined,
      entityType: map.type ? parseEntityType(map.type, mode) : undefined,
      apply,
    }
  }

  if (head === 'edge' && sub === 'add') {
    const fromRef = map.from?.trim()
    const toRef = map.to?.trim()
    const verb = map.verb?.trim()
    if (!fromRef || !toRef || !verb) {
      throw new GraphCommandError(
        `edge add requires --from, --to, and --verb. Example: ${cmd('graph edge add --from a --to b --verb uses --apply', mode)}`
      )
    }
    return {
      op: 'edge-add',
      fromRef,
      toRef,
      verb,
      docId: map['doc-id']?.trim() || map.docId?.trim() || undefined,
      apply,
    }
  }

  if (head === 'edge' && sub === 'remove') {
    const fromRef = map.from?.trim()
    const toRef = map.to?.trim()
    const verb = map.verb?.trim()
    if (!fromRef || !toRef || !verb) {
      throw new GraphCommandError(
        `edge remove requires --from, --to, and --verb. Example: ${cmd('graph edge remove --from a --to b --verb uses --apply', mode)}`
      )
    }
    return {
      op: 'edge-remove',
      fromRef,
      toRef,
      verb,
      apply,
    }
  }

  throw new GraphCommandError(
    `Unknown graph command "${head} ${sub}". Try ${cmd('graph --help', mode)}.`
  )
}

export function parseGraphCommand(args: string[], mode: CmdMode = 'cli'): GraphCommandOptions {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    throw new GraphCommandError(printGraphHelp(mode), 0)
  }

  const opts: GraphCommandOptions = {}

  if (args[0] === 'node' || args[0] === 'edge') {
    opts.mutation = parseMutationPlan(args, mode)
    return opts
  }

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
    entity: { id: string; name: string; type: string; description?: string | null }
    outgoing: Array<{ rel: string; target: { name: string; type: string } }>
    incoming: Array<{ rel: string; source: { name: string; type: string } }>
  } | null>
}

function isDuckGraphWriter(w: GraphWriter): w is DuckGraphWriter {
  return w instanceof DuckGraphWriter
}

async function executeGraphMutation(
  writer: DuckGraphWriter,
  plan: GraphMutationPlan,
  out: GraphOut,
  mode: CmdMode
): Promise<void> {
  if (plan.op === 'node-add') {
    const anchor = plan.id ?? plan.name
    const canonicalId = kbGraphEntityIdKey(anchor)
    if (!plan.apply) {
      out.log('Dry run (no changes). Pass --apply to write.')
      out.log(`  Would upsert entity id=${canonicalId} name=${JSON.stringify(plan.name)}`)
      out.log(`  type=${plan.entityType}`)
      if (plan.description) out.log(`  description=${JSON.stringify(plan.description)}`)
      if (plan.docId) out.log(`  doc_id=${JSON.stringify(plan.docId)}`)
      return
    }
    await writer.upsertEntities([
      {
        id: plan.id ?? plan.name,
        name: plan.name,
        type: plan.entityType,
        description: plan.description ?? null,
        docId: plan.docId,
      },
    ])
    out.log(`Upserted entity ${canonicalId} (${plan.name}).`)
    return
  }

  if (plan.op === 'node-set') {
    if (!plan.apply) {
      out.log('Dry run (no changes). Pass --apply to write.')
      out.log(`  Would update entity matching ${JSON.stringify(plan.target)}`)
      if (plan.name !== undefined) out.log(`  name → ${JSON.stringify(plan.name)}`)
      if (plan.description !== undefined)
        out.log(`  description → ${JSON.stringify(plan.description)}`)
      if (plan.entityType !== undefined) out.log(`  type → ${plan.entityType}`)
      return
    }
    const ok = await writer.updateEntityByRef(plan.target, {
      name: plan.name,
      description: plan.description,
      type: plan.entityType,
    })
    if (!ok) {
      out.log(`No entity matched ${JSON.stringify(plan.target)}.`)
      return
    }
    out.log(`Updated entity matching ${JSON.stringify(plan.target)}.`)
    return
  }

  if (plan.op === 'edge-add') {
    if (!plan.apply) {
      out.log('Dry run (no changes). Pass --apply to write.')
      out.log(
        `  Would add edge ${JSON.stringify(plan.fromRef)} -[${plan.verb}]→ ${JSON.stringify(plan.toRef)}`
      )
      if (plan.docId) out.log(`  doc_id=${JSON.stringify(plan.docId)}`)
      return
    }
    await writer.upsertRelationships([
      { fromId: plan.fromRef, toId: plan.toRef, type: plan.verb, docId: plan.docId },
    ])
    out.log(`Added edge (${plan.fromRef})-[${plan.verb}]->(${plan.toRef}).`)
    return
  }

  if (plan.op === 'edge-remove') {
    if (!plan.apply) {
      out.log('Dry run (no changes). Pass --apply to soft-delete the edge.')
      out.log(
        `  Would remove edge ${JSON.stringify(plan.fromRef)} -[${plan.verb}]→ ${JSON.stringify(plan.toRef)}`
      )
      return
    }
    const n = await writer.softDeleteEdge(plan.fromRef, plan.toRef, plan.verb)
    if (n === 0) {
      out.log('No matching live edge was found (already removed or unknown verb/endpoints).')
      return
    }
    out.log('Soft-deleted the edge (weight set to 0).')
    return
  }

  throw new GraphCommandError(`Unhandled mutation. Try ${cmd('graph --help', mode)}.`)
}

const defaultGraphOut: GraphOut = { log: console.log }

export async function runGraphCommand(
  baseDir: string,
  opts: GraphCommandOptions,
  out: GraphOut = defaultGraphOut,
  writerOverride?: GraphWriter,
  mode: CmdMode = 'cli'
): Promise<void> {
  const writer: GraphWriter =
    writerOverride ?? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(baseDir))

  try {
    await writer.open()

    if (opts.mutation) {
      if (!isDuckGraphWriter(writer)) {
        throw new GraphCommandError(
          'Graph edits require the on-disk DuckDB graph (cannot run against an in-memory test stub).'
        )
      }
      await executeGraphMutation(writer, opts.mutation, out, mode)
      return
    }

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
      out.log(`Entity: ${result.entity.name} [${result.entity.type}] (id: ${result.entity.id})`)
      if (result.entity.description) {
        out.log(`Description: ${result.entity.description}`)
      }
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
