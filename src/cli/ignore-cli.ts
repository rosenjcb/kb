import { readBaseMeta, writeBaseMeta } from './base-meta'
import {
  readOptionalCliValue,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  stripCliFlagWithValue,
} from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'
import { DEFAULT_KB_IGNORE_PATTERNS } from './kb-file'

export class IgnoreCommandError extends Error {}

export interface IgnoreCommandOptions {
  cwd?: string
  mode?: CmdMode
}

export function printIgnoreHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('ignore', mode)} commands`,
    '',
    'Manage the ignore patterns for a KB base. Patterns are gitignore-style globs',
    'excluded from `kb init` / `kb scan` across every repo the base tracks. They are',
    "stored in the base's meta.json, so they persist across rescans of the clones KB",
    'manages under ~/.kb (which you never see directly).',
    '',
    'Usage:',
    `  ${cmd('ignore', mode)}                  Show the base and its ignore patterns`,
    `  ${cmd('ignore list', mode)}             Same as above`,
    `  ${cmd('ignore init', mode)}             Seed the base with sensible default patterns`,
    `  ${cmd('ignore add <pattern...>', mode)} Add one or more ignore patterns`,
    '',
    'All subcommands accept `--base <name>`; without it the active/default base is used.',
    'A repo may also commit its own `.kb` file with an `[ignore]` section — those',
    'patterns are honored too, unioned with the base-level list.',
    '',
    'Examples:',
    `  ${cmd('ignore init', mode)}`,
    `  ${cmd('ignore add "*.tmp" drafts/', mode)}`,
    `  ${cmd('ignore list --base acme', mode)}`,
  ].join('\n')
}

async function resolveTargetBase(
  args: string[],
  cwd: string
): Promise<{ baseDir: string; baseName: string }> {
  const baseArg = readOptionalCliValue(args, '--base')
  if (baseArg) {
    return { baseDir: resolveBaseToDir(baseArg, cwd), baseName: baseArg }
  }
  try {
    const effective = await resolveEffectiveBaseDir(cwd)
    return { baseDir: effective.baseDir, baseName: effective.baseName }
  } catch {
    throw new IgnoreCommandError(
      [
        'No KB base resolved.',
        'Pass `--base <name>`, switch to one with `kb base use <name>`, or create one with `kb init --git <url>`.',
      ].join('\n')
    )
  }
}

function formatIgnoreList(baseName: string, patterns: string[]): string {
  const lines = [`Base: ${baseName}`, '']
  if (patterns.length === 0) {
    lines.push('Ignore patterns: (none)')
    lines.push(
      `Seed defaults with \`${cmd('ignore init')}\` or add your own with \`${cmd('ignore add <pattern>')}\`.`
    )
  } else {
    lines.push('Ignore patterns:')
    for (const pattern of patterns) lines.push(`  ${pattern}`)
  }
  return lines.join('\n')
}

export async function runIgnoreCommand(
  args: string[],
  options: IgnoreCommandOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode ?? 'cli'
  const sub = args[0]

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    return printIgnoreHelp(mode)
  }

  if (!sub || sub.startsWith('-') || sub === 'list' || sub === 'show') {
    const { baseDir, baseName } = await resolveTargetBase(args, cwd)
    const meta = await readBaseMeta(baseDir)
    return formatIgnoreList(baseName, meta?.ignore ?? [])
  }

  if (sub === 'init') {
    const { baseDir, baseName } = await resolveTargetBase(args.slice(1), cwd)
    const meta = await readBaseMeta(baseDir)
    const merged = mergePatterns(meta?.ignore ?? [], DEFAULT_KB_IGNORE_PATTERNS)
    await writeBaseMeta(baseDir, { ignore: merged })
    return [
      `Seeded ignore patterns for base "${baseName}".`,
      '',
      'Ignore patterns:',
      ...merged.map(pattern => `  ${pattern}`),
      '',
      'These apply on the next `kb scan` / `kb init`.',
    ].join('\n')
  }

  if (sub === 'add') {
    const rest = stripCliFlagWithValue(args.slice(1), '--base')
    const patterns = rest.filter(token => token && !token.startsWith('--'))
    if (patterns.length === 0) {
      throw new IgnoreCommandError(`Usage: ${cmd('ignore add <pattern...>', mode)}`)
    }

    const { baseDir, baseName } = await resolveTargetBase(args.slice(1), cwd)
    const meta = await readBaseMeta(baseDir)
    const current = meta?.ignore ?? []
    const merged = mergePatterns(current, patterns)
    const added = merged.length - current.length
    await writeBaseMeta(baseDir, { ignore: merged })

    return [
      added > 0
        ? `Added ${added} pattern${added === 1 ? '' : 's'} to base "${baseName}".`
        : `No new patterns added (already present) — base "${baseName}".`,
      '',
      'Ignore patterns:',
      ...merged.map(pattern => `  ${pattern}`),
    ].join('\n')
  }

  throw new IgnoreCommandError(`Unknown ignore subcommand: ${sub}\n\n${printIgnoreHelp(mode)}`)
}

function mergePatterns(existing: string[], additions: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...existing, ...additions]) {
    const pattern = raw.trim()
    if (!pattern || seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}
