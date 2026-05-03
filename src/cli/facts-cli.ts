import { formatFactUri } from '../core/fact-uri'
import type { FactRow } from '../tools/sqlite-kb-index'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { ensureOperationalBaseDir, resolveEffectiveBaseDir } from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'

export type FactsOutputMode = 'human' | 'json'

export class FactsCommandError extends Error {
  exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'FactsCommandError'
    this.exitCode = exitCode
  }
}

export function printFactsHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('facts', mode)} — inspect the canonical facts store`,
    '',
    'Usage:',
    `  ${cmd('facts list', mode)} [--base <name>] [--limit <n>] [--output human|json]`,
    `  ${cmd('facts search', mode)} "<query>" [--base <name>] [--limit <n>] [--output human|json]`,
    `  ${cmd('facts show', mode)} "<fact id or exact text>" [--base <name>] [--output human|json]`,
    '',
    'Examples:',
    `  ${cmd('facts list --limit 10', mode)}`,
    `  ${cmd('facts search "hybrid retrieval"', mode)}`,
    `  ${cmd('facts show fact-a1b2c3d4e5f67890', mode)}`,
  ].join('\n')
}

export interface ParsedFactsCommand {
  sub: 'list' | 'search' | 'show'
  base?: string
  limit: number
  output: FactsOutputMode
  /** search / show query text */
  query?: string
}

function readFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parseFactsTail(tail: string[]): {
  base?: string
  limitRaw?: string
  outputRaw?: string
  positional: string[]
} {
  const positional: string[] = []
  let base: string | undefined
  let limitRaw: string | undefined
  let outputRaw: string | undefined
  for (let i = 0; i < tail.length; ) {
    const t = tail[i] ?? ''
    if (t === '--base') {
      const v = tail[i + 1]
      if (!v || v.startsWith('--')) {
        throw new FactsCommandError(`--base requires a value\n\n${printFactsHelp()}`)
      }
      base = v
      i += 2
      continue
    }
    if (t === '--limit') {
      const v = tail[i + 1]
      if (!v || v.startsWith('--')) {
        throw new FactsCommandError(`--limit requires a value\n\n${printFactsHelp()}`)
      }
      limitRaw = v
      i += 2
      continue
    }
    if (t === '--output') {
      const v = tail[i + 1]
      if (!v || v.startsWith('--')) {
        throw new FactsCommandError(`--output requires a value\n\n${printFactsHelp()}`)
      }
      outputRaw = v
      i += 2
      continue
    }
    if (t.startsWith('--')) {
      throw new FactsCommandError(`Unknown option: ${t}\n\n${printFactsHelp()}`)
    }
    positional.push(t)
    i += 1
  }
  return { base, limitRaw, outputRaw, positional }
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, 200)
}

export function parseFactsCommand(args: string[]): ParsedFactsCommand {
  if (
    args.length === 0 ||
    readFlag(args, '--help') ||
    readFlag(args, '-h') ||
    args[0] === 'help' ||
    args[0] === '--help'
  ) {
    throw new FactsCommandError(printFactsHelp(), 0)
  }

  const sub = args[0]?.toLowerCase()
  if (sub !== 'list' && sub !== 'search' && sub !== 'show') {
    throw new FactsCommandError(`Unknown facts subcommand: ${args[0] ?? ''}\n\n${printFactsHelp()}`)
  }

  const tail = args.slice(1)
  if (readFlag(tail, '--help') || readFlag(tail, '-h')) {
    throw new FactsCommandError(printFactsHelp(), 0)
  }

  const { base, limitRaw, outputRaw, positional } = parseFactsTail(tail)
  const limit = parseLimit(limitRaw, sub === 'list' ? 30 : 15)
  const output: FactsOutputMode = outputRaw?.toLowerCase() === 'json' ? 'json' : 'human'

  if (sub === 'list') {
    if (positional.length > 0) {
      throw new FactsCommandError(`facts list does not accept extra arguments.\n\n${printFactsHelp()}`)
    }
    return { sub: 'list', base, limit, output }
  }

  const q = positional.join(' ').trim()
  if (!q) {
    throw new FactsCommandError(`facts ${sub} requires a query string.\n\n${printFactsHelp()}`)
  }

  return { sub, base, limit, output, query: q }
}

async function resolveBaseDir(parsed: ParsedFactsCommand, cwd: string): Promise<string> {
  return parsed.base ? await ensureOperationalBaseDir(parsed.base, cwd) : (await resolveEffectiveBaseDir(cwd)).baseDir
}

function formatFactJson(row: FactRow): Record<string, unknown> {
  return {
    id: row.id,
    fact_text: row.fact_text,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    lane_id: row.lane_id,
    source_kind: row.source_kind,
    source_ref: row.source_ref,
    uri: formatFactUri(row.id),
  }
}

function formatFactHuman(row: FactRow, baseLabel?: string): string {
  const baseLine = baseLabel ? `base: ${baseLabel}\n` : ''
  return [
    `${baseLine}id: ${row.id}`,
    `uri: ${formatFactUri(row.id)}`,
    `lane: ${row.lane_id}`,
    `source: ${row.source_kind}${row.source_ref ? ` (${row.source_ref})` : ''}`,
    `triple: (${row.subject}) [${row.predicate}] (${row.object})`,
    '',
    row.fact_text.trim(),
  ].join('\n')
}

export async function runFactsCommand(
  args: string[],
  options: { cwd?: string } = {}
): Promise<string> {
  const parsed = parseFactsCommand(args)
  const cwd = options.cwd ?? process.cwd()
  const baseDir = await resolveBaseDir(parsed, cwd)
  const dbPath = `${baseDir}/.kb-index.sqlite`
  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    if (parsed.sub === 'list') {
      const rows = indexer.listFactsForQuery(parsed.limit)
      if (parsed.output === 'json') {
        return JSON.stringify({ facts: rows.map(formatFactJson) }, null, 2)
      }
      if (rows.length === 0) return '(no live facts in this base)'
      return rows.map((r, i) => `--- ${i + 1} ---\n${formatFactHuman(r, parsed.base)}`).join('\n\n')
    }

    if (parsed.sub === 'search') {
      const rows = indexer.searchFacts(parsed.query ?? '', parsed.limit)
      if (parsed.output === 'json') {
        return JSON.stringify({ query: parsed.query, facts: rows.map(formatFactJson) }, null, 2)
      }
      if (rows.length === 0) return `No facts matched: ${parsed.query}`
      return rows.map((r, i) => `--- ${i + 1} ---\n${formatFactHuman(r, parsed.base)}`).join('\n\n')
    }

  const q = (parsed.query ?? '').trim()
  const byId = /^fact-[a-f0-9]{16}$/i.test(q) ? indexer.getActiveFactById(q) : undefined
    const row = byId ?? indexer.getActiveFactByTextMatch(q)
    if (!row) {
      throw new FactsCommandError(`No active fact matched: ${q}`)
    }
    if (parsed.output === 'json') {
      return JSON.stringify(formatFactJson(row), null, 2)
    }
    return formatFactHuman(row, parsed.base)
  } finally {
    indexer.close()
  }
}
