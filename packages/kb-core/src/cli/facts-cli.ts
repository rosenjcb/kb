import { basename } from 'node:path'
import type { FactRow } from '@kb/core/tools/sqlite-kb-index.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { ensureOperationalBaseDir, resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'

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
    `  ${cmd('facts list', mode)} [--base <name>] [--limit <n>]`,
    `  ${cmd('facts search', mode)} "<query>" [--base <name>] [--limit <n>]`,
    `  ${cmd('facts show', mode)} "<fact id or exact text>" [--base <name>]`,
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
  /** search / show query text */
  query?: string
}

function readFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parseFactsTail(tail: string[]): {
  base?: string
  limitRaw?: string
  positional: string[]
} {
  const positional: string[] = []
  let base: string | undefined
  let limitRaw: string | undefined
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
    if (t.startsWith('--')) {
      throw new FactsCommandError(`Unknown option: ${t}\n\n${printFactsHelp()}`)
    }
    positional.push(t)
    i += 1
  }
  return { base, limitRaw, positional }
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

  const { base, limitRaw, positional } = parseFactsTail(tail)
  const limit = parseLimit(limitRaw, sub === 'list' ? 30 : 15)

  if (sub === 'list') {
    if (positional.length > 0) {
      throw new FactsCommandError(
        `facts list does not accept extra arguments.\n\n${printFactsHelp()}`
      )
    }
    return { sub: 'list', base, limit }
  }

  const q = positional.join(' ').trim()
  if (!q) {
    throw new FactsCommandError(`facts ${sub} requires a query string.\n\n${printFactsHelp()}`)
  }

  return { sub, base, limit, query: q }
}

async function resolveBaseDir(parsed: ParsedFactsCommand, cwd: string): Promise<string> {
  return parsed.base
    ? await ensureOperationalBaseDir(parsed.base, cwd)
    : (await resolveEffectiveBaseDir(cwd)).baseDir
}

function repoLabel(row: FactRow): string {
  return row.git_repo?.trim() || '(unscoped)'
}

/**
 * One fact as a compact entry: the claim first, then a single metadata line.
 * The base is shown once in the list header, not per row; repo/evidence are shown
 * once here rather than repeated across id/uri/source_ref (the old format restated
 * the same repo three times).
 */
function formatFactListItem(row: FactRow, index: number): string {
  return `${index}. ${row.text.trim()}\n   ${row.id} · ${repoLabel(row)} · ${row.evidence}`
}

/** Full detail for `facts show` — the claim, then its metadata, each shown once. */
function formatFactDetail(row: FactRow, baseName: string): string {
  const lines = [
    row.text.trim(),
    '',
    `id:        ${row.id}`,
    `repo:      ${repoLabel(row)}`,
    `evidence:  ${row.evidence}`,
  ]
  if (row.source_ref) lines.push(`source:    ${row.source_ref}`)
  lines.push(`base:      ${baseName}`)
  return lines.join('\n')
}

/** Render a list/search result set with a single header naming the base. */
function formatFactList(rows: FactRow[], baseName: string, heading: string): string {
  const body = rows.map((r, i) => formatFactListItem(r, i + 1)).join('\n\n')
  return `${heading} in base "${baseName}":\n\n${body}`
}

function buildRepoStatsBlock(indexer: SqliteKbIndexer): string {
  const stats = indexer.listRepoStats()
  if (stats.length === 0) return ''
  const total = stats.reduce((sum, s) => sum + s.count, 0)
  const maxNameLen = Math.max(...stats.map(s => s.repo.length))
  const maxCountLen = String(Math.max(...stats.map(s => s.count))).length
  const rows = stats.map(s => {
    const pct = total > 0 ? Math.round((s.count / total) * 100) : 0
    return `  ${s.repo.padEnd(maxNameLen)}  ${String(s.count).padStart(maxCountLen)}  ${pct}%`
  })
  return [`Repo breakdown (${total} facts):`, ...rows].join('\n')
}

export async function runFactsCommand(
  args: string[],
  options: { cwd?: string } = {}
): Promise<string> {
  const isHelp =
    args.length === 0 ||
    args[0] === '--help' ||
    args[0] === '-h' ||
    args[0] === 'help' ||
    args[0] === '--help'
  if (isHelp) {
    const cwd = options.cwd ?? process.cwd()
    let statsBlock = ''
    try {
      const { baseDir } = await resolveEffectiveBaseDir(cwd)
      const indexer = new SqliteKbIndexer({ dbPath: `${baseDir}/.kb-index.sqlite` })
      try {
        statsBlock = buildRepoStatsBlock(indexer)
      } finally {
        indexer.close()
      }
    } catch {
      // no base configured or DB not found — show help without stats
    }
    const help = printFactsHelp()
    throw new FactsCommandError(
      statsBlock ? help.replace('\n\nUsage:', `\n\n${statsBlock}\n\nUsage:`) : help,
      0
    )
  }

  const parsed = parseFactsCommand(args)
  const cwd = options.cwd ?? process.cwd()
  const baseDir = await resolveBaseDir(parsed, cwd)
  const baseName = basename(baseDir)
  const dbPath = `${baseDir}/.kb-index.sqlite`
  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    if (parsed.sub === 'list') {
      const rows = indexer.listFactsForQuery(parsed.limit)
      if (rows.length === 0) return `No facts in base "${baseName}".`
      return formatFactList(rows, baseName, `${rows.length} fact${rows.length === 1 ? '' : 's'}`)
    }

    if (parsed.sub === 'search') {
      const rows = indexer.searchFacts(parsed.query ?? '', parsed.limit)
      if (rows.length === 0) return `No facts matched "${parsed.query}" in base "${baseName}".`
      return formatFactList(rows, baseName, `${rows.length} match${rows.length === 1 ? '' : 'es'} for "${parsed.query}"`)
    }

    const q = (parsed.query ?? '').trim()
    const byId = /^fact-[a-f0-9]{16}$/i.test(q) ? indexer.getActiveFactById(q) : undefined
    const row = byId ?? indexer.getActiveFactByTextMatch(q)
    if (!row) {
      throw new FactsCommandError(`No active fact matched: ${q}`)
    }
    return formatFactDetail(row, baseName)
  } finally {
    indexer.close()
  }
}
