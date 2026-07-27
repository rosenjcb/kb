/**
 * kb entities — inspect the Organizational Ontology Index.
 *
 *   kb entities                      Summary: entities by kind, link counts
 *   kb entities --kind service      Filter listing by kind
 *   kb entities --entity <name>     One entity: kind, gloss, aliases, links, collisions
 *   kb entities collisions          The nomenclature audit: every distinct_from pair
 *
 * Read-only. The registry is populated by the `entity-index` scan cycle
 * (kb init / kb scan); see NOMENCLATURE_INDEX_PLAN.md.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import { EntityRegistry, type EntityKind } from '@kb/core/tools/entity-registry.js'

export interface EntitiesCommandOptions {
  subcommand?: 'collisions'
  kind?: EntityKind
  entity?: string
}

export class EntitiesCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message)
    this.name = 'EntitiesCommandError'
  }
}

const KNOWN_KINDS: EntityKind[] = [
  'domain',
  'team',
  'service',
  'surface',
  'repo',
  'module',
  'api',
  'library',
  'cli',
]

export function printEntitiesHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('entities', mode)} commands`,
    '',
    'Global option (all subcommands):',
    `  ${cmd('[--base <name>]', mode)}   Session KB to inspect (defaults to active base)`,
    '',
    'Inspect:',
    `  ${cmd('entities', mode)}                     List known entities (services, surfaces, …)`,
    `  ${cmd('entities --kind <kind>', mode)}       Filter by kind (${KNOWN_KINDS.join('|')})`,
    `  ${cmd('entities --entity <name>', mode)}     Show one entity: aliases, links, collisions`,
    `  ${cmd('entities collisions', mode)}          Nomenclature audit: confusable name pairs`,
    '',
    'Notes:',
    '  Entities are harvested from manifests (package.json, compose, fly.toml, catalog-info.yaml)',
    '  by the entity-index cycle during `kb init` / `kb scan`. Queries use them to infer scope',
    '  before retrieval so similarly named things stop conflating.',
  ].join('\n')
}

export function parseEntitiesCommand(args: string[], mode: CmdMode = 'cli'): EntitiesCommandOptions {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    throw new EntitiesCommandError(printEntitiesHelp(mode), 0)
  }

  const opts: EntitiesCommandOptions = {}
  if (args[0] === 'collisions') opts.subcommand = 'collisions'

  const kindIndex = args.indexOf('--kind')
  if (kindIndex !== -1 && args[kindIndex + 1]) {
    const kind = args[kindIndex + 1] as EntityKind
    if (!KNOWN_KINDS.includes(kind)) {
      throw new EntitiesCommandError(`Unknown entity kind: ${kind}. Kinds: ${KNOWN_KINDS.join(', ')}`)
    }
    opts.kind = kind
  }

  const entityIndex = args.indexOf('--entity')
  if (entityIndex !== -1 && args[entityIndex + 1]) {
    opts.entity = args[entityIndex + 1]
  }

  return opts
}

export interface EntitiesOut {
  log(message: string): void
}

const defaultOut: EntitiesOut = { log: console.log }

export async function runEntitiesCommand(
  baseDir: string,
  opts: EntitiesCommandOptions,
  out: EntitiesOut = defaultOut
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) {
    out.log('No KB index found. Run `kb init` to build the knowledge base.')
    return
  }

  const registry = new EntityRegistry(dbPath, { readOnly: true })
  try {
    if (opts.subcommand === 'collisions') {
      const collisions = registry.listCollisions()
      if (collisions.length === 0) {
        out.log('No name collisions detected. (distinct_from edges: 0)')
        return
      }
      const lines = [`Nomenclature audit — ${collisions.length} confusable pair(s):`, '']
      for (const c of collisions) {
        lines.push(`  ${c.fromEntity.canonicalName} (${c.fromEntity.kind})  ×  ${c.toEntity.canonicalName} (${c.toEntity.kind})`)
        if (c.gloss) lines.push(`    ${c.gloss}`)
      }
      out.log(lines.join('\n'))
      return
    }

    if (opts.entity) {
      const matches = registry.findEntityByName(opts.entity)
      if (matches.length === 0) {
        out.log(`No entity found matching "${opts.entity}".`)
        return
      }
      const lines: string[] = []
      for (const entity of matches) {
        lines.push(`${entity.canonicalName}  [${entity.kind}]`)
        if (entity.gloss) lines.push(`  ${entity.gloss}`)
        if (entity.gitRepo) lines.push(`  repo: ${entity.gitRepo}`)
        lines.push(`  source: ${entity.sourceKind} (confidence ${entity.confidence})`)
        const aliases = registry.listAliases(entity.id).map(a => a.alias)
        if (aliases.length > 0) lines.push(`  aliases: ${aliases.join(', ')}`)
        lines.push(`  linked facts: ${registry.linkedFactIds([entity.id]).length}`)
        const collisions = registry.distinctFromSiblings(entity.id)
        for (const c of collisions) {
          const other = c.fromEntity.id === entity.id ? c.toEntity : c.fromEntity
          lines.push(`  ⚠ distinct from: ${other.canonicalName} (${other.kind})`)
        }
        lines.push('')
      }
      out.log(lines.join('\n').trimEnd())
      return
    }

    const entities = registry.listEntities(opts.kind)
    if (entities.length === 0) {
      out.log(
        opts.kind
          ? `No ${opts.kind} entities in the registry.`
          : 'Entity registry is empty. Run `kb scan` to harvest entities from tracked repos.'
      )
      return
    }
    const lines = [`${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}:`, '']
    for (const entity of entities) {
      const links = registry.linkedFactIds([entity.id]).length
      const repoNote = entity.gitRepo && entity.kind !== 'repo' ? `  (${entity.gitRepo})` : ''
      lines.push(`  ${entity.canonicalName}  [${entity.kind}]${repoNote}  ${links} fact(s)`)
    }
    out.log(lines.join('\n'))
  } finally {
    registry.close()
  }
}
