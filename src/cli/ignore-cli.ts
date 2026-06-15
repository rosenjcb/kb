import path from 'node:path'
import { type CmdMode, cmd } from './cmd-ref'
import {
  DEFAULT_KB_IGNORE_PATTERNS,
  type FoundKbFile,
  findKbFileInfo,
  readKbFileAt,
  writeKbFileAt,
} from './kb-file'

export class IgnoreCommandError extends Error {}

export interface IgnoreCommandOptions {
  cwd?: string
  mode?: CmdMode
}

export function printIgnoreHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('ignore', mode)} commands`,
    '',
    'Manage the `.kb` project file: it maps this directory to a KB base and',
    'lists gitignore-style patterns excluded from `kb init` / `kb scan`.',
    '',
    'Usage:',
    `  ${cmd('ignore', mode)}                  Show the active .kb file and its ignore patterns`,
    `  ${cmd('ignore list', mode)}             Same as above`,
    `  ${cmd('ignore init', mode)}             Create a .kb file here, seeded with sensible defaults`,
    `  ${cmd('ignore add <pattern...>', mode)} Add one or more ignore patterns`,
    '',
    'Examples:',
    `  ${cmd('ignore init', mode)}`,
    `  ${cmd('ignore add "*.tmp" drafts/', mode)}`,
    `  ${cmd('ignore list', mode)}`,
  ].join('\n')
}

function formatKbFile(found: FoundKbFile | null, cwd: string): string {
  if (!found) {
    return [
      'No .kb file found for this directory.',
      `Run \`${cmd('ignore init')}\` to create one in ${cwd}.`,
    ].join('\n')
  }

  const lines = [`.kb file: ${found.filePath}`]
  if (found.base) lines.push(`Base: ${found.base}`)
  lines.push('')
  if (found.ignore.length === 0) {
    lines.push('Ignore patterns: (none)')
    lines.push(`Add some with \`${cmd('ignore add <pattern>')}\`.`)
  } else {
    lines.push('Ignore patterns:')
    for (const pattern of found.ignore) lines.push(`  ${pattern}`)
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

  if (!sub || sub === 'list' || sub === 'show') {
    const found = await findKbFileInfo(cwd)
    return formatKbFile(found, cwd)
  }

  if (sub === 'init') {
    const existing = await readKbFileAt(cwd)
    const inherited = existing ? null : await findKbFileInfo(cwd)
    const base = existing?.base ?? inherited?.base
    const merged = mergePatterns(existing?.ignore ?? [], DEFAULT_KB_IGNORE_PATTERNS)
    await writeKbFileAt(cwd, { base, ignore: merged })

    const verb = existing ? 'Updated' : 'Created'
    const target = path.join(cwd, '.kb')
    return [
      `${verb} ${target}`,
      base ? `Base: ${base}` : 'Base: (not set — run `kb init` to map this directory to a base)',
      '',
      'Ignore patterns:',
      ...merged.map(pattern => `  ${pattern}`),
      '',
      'Edit the file to fine-tune what `kb init` / `kb scan` pick up.',
    ].join('\n')
  }

  if (sub === 'add') {
    const patterns = args.slice(1).filter(token => token && !token.startsWith('--'))
    if (patterns.length === 0) {
      throw new IgnoreCommandError(`Usage: ${cmd('ignore add <pattern...>', mode)}`)
    }

    // Update the governing .kb file when one exists; otherwise create one here.
    const found = await findKbFileInfo(cwd)
    const targetDir = found?.dir ?? cwd
    const current = found ?? { base: undefined, ignore: [] }
    const merged = mergePatterns(current.ignore, patterns)
    const added = merged.length - current.ignore.length
    await writeKbFileAt(targetDir, { base: current.base, ignore: merged })

    const target = path.join(targetDir, '.kb')
    return [
      added > 0
        ? `Added ${added} pattern${added === 1 ? '' : 's'} to ${target}`
        : `No new patterns added (already present) — ${target}`,
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
