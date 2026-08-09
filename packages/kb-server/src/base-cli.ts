/**
 * `kb-server base <list|create|add-repo|delete>` — operator base management, run on the
 * server host.
 *
 * These are the hands-on admin counterparts to the boot-time flow: `kb-server start
 * --base <name> --git <repo>` builds a base from env/flags for CI/CD, while these
 * commands let a local admin create bases and attach repos interactively. None of this
 * is reachable from the `kb` client — the client can only switch bases (`kb base use`).
 *
 * The target base is always an explicit `--base <name>` flag (never a positional or an
 * implicit default), so it is unambiguous which base a command touches.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { type GitTarget, parseGitTarget, runKbInit } from '@kb/core/ops/init-cli.js'
import {
  DEFAULT_BASE_SLUG,
  deleteBase,
  formatDeleteBaseResult,
  listAllBases,
  resolveBaseToDir,
} from '@kb/core/storage/base-selection.js'

export interface ServerLogger {
  log(message: string): void
  error(message: string): void
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

const BASE_USAGE = `Usage: kb-server base <command>

Commands:
  list                                 List all initialized bases on this server.
  create   --base <name> --git <url>…  Create a base and index one or more git repos.
  add-repo --base <name> --git <url>…  Add git repos to an existing base and re-index.
  delete   --base <name> [--yes|-y]    Delete a base and all its data on this server.

Notes:
  • The target base is always the explicit --base flag (no positional, no implicit default).
  • --git is repeatable; pin a branch with url#branch.
  • CI/CD can still build a base at boot: \`kb-server start --base <name> --git <url>\`.
  • To remove all server data instead of one base, use \`kb-server uninstall --purge\`.

Examples:
  kb-server base create   --base raylib --git https://github.com/raysan5/raylib
  kb-server base add-repo  --base default --git https://github.com/raysan5/raygui#main
  kb-server base list
  kb-server base delete   --base raylib --yes`

/** Read the value after a single-value flag (e.g. `--base <name>`). */
function readFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  return value && !value.startsWith('-') ? value : undefined
}

/** Collect repeatable `--git <url>` values into parsed GitTargets. */
function parseGitTargets(args: string[]): GitTarget[] {
  const targets: GitTarget[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--git' && i + 1 < args.length) {
      const value = args[i + 1]
      if (value && !value.startsWith('-')) {
        targets.push(parseGitTarget(value))
        i++
      }
    }
  }
  return targets
}

/** True when a base already has a built index on disk. */
function baseIndexExists(name: string): boolean {
  return existsSync(path.join(resolveBaseToDir(name), '.kb-index.sqlite'))
}

async function runBaseList(out: ServerLogger): Promise<void> {
  const bases = await listAllBases()
  if (bases.length === 0) {
    out.log('No initialized bases found.')
    out.log('Create one with `kb-server base create --base <name> --git <url>`.')
    return
  }
  out.log('KB bases (server)')
  for (const b of bases) {
    out.log(`  ${b.name}${b.isActive ? '  [active]' : ''}`)
    out.log(`    ${b.path}`)
  }
}

async function runBaseCreate(args: string[], out: ServerLogger): Promise<void> {
  const name = readFlagValue(args, '--base')
  const targets = parseGitTargets(args)

  if (!name) {
    out.error('--base <name> is required: kb-server base create --base <name> --git <url>')
    process.exitCode = 1
    return
  }
  if (name === DEFAULT_BASE_SLUG) {
    out.error(
      `The "${DEFAULT_BASE_SLUG}" base always exists — you don't create it. Add repos with ` +
        `\`kb-server base add-repo --base ${DEFAULT_BASE_SLUG} --git <url>\`.`
    )
    process.exitCode = 1
    return
  }
  if (baseIndexExists(name)) {
    out.error(
      `Base "${name}" already exists. Add more repos with \`kb-server base add-repo --base ${name} --git <url>\`.`
    )
    process.exitCode = 1
    return
  }
  if (targets.length === 0) {
    out.error(
      'At least one repo is required: kb-server base create --base <name> --git <url> [--git <url>…]'
    )
    process.exitCode = 1
    return
  }

  out.log(`Creating base "${name}" from ${targets.length} repo(s)…`)
  await runKbInit({
    base: name,
    nonInteractive: true,
    gitTargets: targets,
    progressSink: line => out.log(line),
  })
  out.log(`Base "${name}" created. Clients can select it with \`kb base use ${name}\`.`)
}

async function runBaseAddRepo(args: string[], out: ServerLogger): Promise<void> {
  const name = readFlagValue(args, '--base')
  const targets = parseGitTargets(args)

  if (!name) {
    out.error('--base <name> is required: kb-server base add-repo --base <name> --git <url>')
    process.exitCode = 1
    return
  }
  // The default base always exists (it may be empty); any other base must have been
  // created first. `create` requires repos, so a known non-default base always has an index.
  if (name !== DEFAULT_BASE_SLUG && !baseIndexExists(name)) {
    out.error(
      `No base "${name}" on this server. Create it first with \`kb-server base create --base ${name} --git <url>\`.`
    )
    process.exitCode = 1
    return
  }
  if (targets.length === 0) {
    out.error(
      'At least one repo is required: kb-server base add-repo --base <name> --git <url> [--git <url>…]'
    )
    process.exitCode = 1
    return
  }

  out.log(`Adding ${targets.length} repo(s) to base "${name}" and re-indexing…`)
  // An idempotent init against an existing base folds in newly-listed remotes, re-syncs the
  // tracked repos, and rebuilds cross-repo links (runExistingBaseSwap).
  await runKbInit({
    base: name,
    nonInteractive: true,
    gitTargets: targets,
    progressSink: line => out.log(line),
  })
  out.log(`Base "${name}" updated.`)
}

async function runBaseDelete(args: string[], out: ServerLogger): Promise<void> {
  const yes =
    args.includes('--yes') || args.includes('-y') || args.includes('--force') || args.includes('-f')
  const name = readFlagValue(args, '--base')

  if (!name) {
    out.error('--base <name> is required: kb-server base delete --base <name>')
    process.exitCode = 1
    return
  }

  if (!yes && !process.stdin.isTTY) {
    out.error('Deleting a base requires an interactive terminal. Pass --yes to skip the prompt.')
    process.exitCode = 1
    return
  }

  if (!yes) {
    const answer = await prompt(
      `Delete base "${name}" and all its data on this server? This cannot be undone. [y/N]: `
    )
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      out.log('Cancelled.')
      return
    }
  }

  const result = await deleteBase(name)
  out.log(formatDeleteBaseResult(name, result))
}

export async function runServerBaseCommand(args: string[], out: ServerLogger): Promise<void> {
  const sub = args[0]

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    out.log(BASE_USAGE)
    return
  }

  switch (sub) {
    case 'list':
      await runBaseList(out)
      return
    case 'create':
      await runBaseCreate(args.slice(1), out)
      return
    case 'add-repo':
      await runBaseAddRepo(args.slice(1), out)
      return
    case 'delete':
      await runBaseDelete(args.slice(1), out)
      return
    default:
      out.error(`Unknown base subcommand: ${sub}\n\n${BASE_USAGE}`)
      process.exitCode = 1
  }
}
