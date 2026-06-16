/**
 * `kb base repo list|add|remove` — manage the git repos a base tracks.
 *
 * The repo list lives in the base's `meta.json` (not the global config). Adding clones +
 * indexes the repo into the one base graph; removing purges its facts and clone. After any
 * mutation we re-run cross-repo reconciliation so the graph stays one connected tree.
 *
 * Also hosts `kb base ignore …` (gitignore-style scan-exclusion patterns) since it shares the
 * same `meta.json` plumbing.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import {
  type GitBaseMeta,
  type GitRepoMeta,
  readBaseMeta,
  repoDirForSlug,
  repoSlugFromGitUrl,
  writeBaseMeta,
} from './base-meta'
import { resolveBaseToDir, resolveEffectiveBaseDir } from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'
import { cloneRepo, getCurrentBranch, getHeadSha } from './git-sync'
import { parseGitTarget, runKbInit } from './init-cli'
import { normalizeIgnorePatterns, parseIgnoreInput } from './kb-ignore'

export interface RepoCommandResult {
  output: string
}

export interface RunRepoCommandOptions {
  mode?: CmdMode
  onProgress?: (line: string) => void
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx < 0) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

async function resolveRepoBaseDir(baseArg?: string): Promise<{ baseDir: string; baseName: string }> {
  if (baseArg) {
    const baseDir = resolveBaseToDir(baseArg)
    return { baseDir, baseName: path.basename(baseDir) }
  }
  const effective = await resolveEffectiveBaseDir()
  return { baseDir: effective.baseDir, baseName: effective.baseName }
}

function reconcile(baseDir: string, onProgress?: (line: string) => void): void {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    const linked = indexer.reconcileCrossRepoEdges()
    if (linked > 0) onProgress?.(`Linked ${linked} cross-repo edge(s).`)
  } finally {
    indexer.close()
  }
}

const REPO_VERBS = new Set(['list', 'add', 'remove'])

/**
 * `kb base repo [list|add|remove] …`. A bare `kb base repo` (or `… repo list`) lists the
 * tracked repos; `add <url>` clones + indexes; `remove <url|slug>` purges facts + clone.
 */
export async function runRepoCommand(
  args: string[],
  options: RunRepoCommandOptions = {}
): Promise<RepoCommandResult> {
  const mode = options.mode ?? 'cli'
  const baseArg = readOption(args, '--base')
  const branch = readOption(args, '--branch')
  const positional = args.filter(a => !a.startsWith('--') && a !== baseArg && a !== branch)
  const verb = positional[0] ?? 'list'
  if (!REPO_VERBS.has(verb)) {
    throw new Error(
      `Unknown repo command "${verb}". Use: ${cmd('base repo [list|add|remove]', mode)}`
    )
  }
  const target = positional[1]

  if (verb === 'list') {
    const { baseDir, baseName } = await resolveRepoBaseDir(baseArg)
    const meta = await readBaseMeta(baseDir)
    if (!meta || meta.repos.length === 0) {
      return { output: `Base "${baseName}" tracks no git repos.` }
    }
    const lines = meta.repos.map(
      r =>
        `  ${r.slug}  ${r.gitUrl} (${r.gitBranch})  synced ${r.lastSyncedSha.slice(0, 8)} @ ${r.lastSyncedAt}`
    )
    return { output: [`Repos tracked by "${baseName}":`, ...lines].join('\n') }
  }

  if (verb === 'add') {
    if (!target) {
      throw new Error(`${cmd('base repo add', mode)} requires a git URL (optionally url#branch)`)
    }
    const gitTarget = parseGitTarget(target, branch)
    const { baseDir, baseName } = await resolveRepoBaseDir(baseArg)
    const meta: GitBaseMeta = (await readBaseMeta(baseDir)) ?? { repos: [] }
    const slug = repoSlugFromGitUrl(gitTarget.url)
    if (meta.repos.some(r => r.slug === slug)) {
      throw new Error(`Repo "${slug}" is already tracked by base "${baseName}".`)
    }
    const dir = repoDirForSlug(slug)
    const repoDir = path.join(baseDir, dir)
    const branchLabel = gitTarget.branch ?? 'default branch'
    options.onProgress?.(`Cloning ${gitTarget.url} (${branchLabel})…`)
    if (!existsSync(repoDir)) {
      await cloneRepo(gitTarget.url, repoDir, gitTarget.branch)
    }
    const gitBranch = gitTarget.branch ?? (await getCurrentBranch(repoDir))
    const headSha = await getHeadSha(repoDir)
    options.onProgress?.(`Indexing ${slug}…`)
    await runKbInit({
      base: baseName,
      cwd: repoDir,
      rescan: true,
      apply: true,
      nonInteractive: true,
      gitRepo: slug,
      progressSink: options.onProgress,
    })
    const entry: GitRepoMeta = {
      gitUrl: gitTarget.url,
      gitBranch,
      slug,
      dir,
      lastSyncedSha: headSha,
      lastSyncedAt: new Date().toISOString(),
    }
    await writeBaseMeta(baseDir, { ...meta, repos: [...meta.repos, entry] })
    reconcile(baseDir, options.onProgress)
    return { output: `Added repo "${slug}" to base "${baseName}".` }
  }

  // verb === 'remove'
  if (!target) {
    throw new Error(`${cmd('base repo remove', mode)} requires a git URL or repo slug`)
  }
  const { baseDir, baseName } = await resolveRepoBaseDir(baseArg)
  const meta = await readBaseMeta(baseDir)
  if (!meta || meta.repos.length === 0) {
    throw new Error(`Base "${baseName}" tracks no git repos.`)
  }
  const wantedSlug = repoSlugFromGitUrl(target)
  const repo = meta.repos.find(
    r => r.slug === target || r.gitUrl === target || r.slug === wantedSlug
  )
  if (!repo) {
    throw new Error(`No repo matching "${target}" in base "${baseName}".`)
  }
  if (meta.repos.length === 1) {
    throw new Error(
      `Cannot remove the last repo from base "${baseName}". Delete the base instead: ${cmd(`base delete ${baseName}`, mode)}.`
    )
  }
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  let removedFacts = 0
  try {
    removedFacts = indexer.deleteFactsByRepo(repo.slug)
    indexer.reconcileCrossRepoEdges()
  } finally {
    indexer.close()
  }
  await rm(path.join(baseDir, repo.dir), { recursive: true, force: true })
  await writeBaseMeta(baseDir, { ...meta, repos: meta.repos.filter(r => r.slug !== repo.slug) })
  return {
    output: `Removed repo "${repo.slug}" from base "${baseName}" (purged ${removedFacts} fact(s)).`,
  }
}

const IGNORE_VERBS = new Set(['list', 'add', 'remove', 'set', 'clear'])

/**
 * `kb base ignore [list|add|remove|set|clear] [patterns…]` — manage a base's gitignore-style
 * ignore list (stored in meta.json, respected on every scan). Follows the noun-then-verb style
 * (`git remote …`): a bare `kb base ignore` (or `… ignore list`) prints the current patterns.
 *   add <patterns…>     append patterns
 *   remove <patterns…>  drop patterns
 *   set <patterns…>     replace the whole list
 *   clear               remove all patterns
 * Patterns may be repeated args and/or comma-separated within one arg.
 */
export async function runIgnoreCommand(
  args: string[],
  options: RunRepoCommandOptions = {}
): Promise<RepoCommandResult> {
  const mode = options.mode ?? 'cli'
  const baseArg = readOption(args, '--base')
  const positional = args.filter(a => !a.startsWith('--') && a !== baseArg)
  const verb = positional[0] ?? 'list'
  if (!IGNORE_VERBS.has(verb)) {
    throw new Error(
      `Unknown ignore command "${verb}". Use: ${cmd('base ignore [list|add|remove|set|clear]', mode)}`
    )
  }
  const patterns = positional.slice(1).flatMap(parseIgnoreInput)

  const { baseDir, baseName } = await resolveRepoBaseDir(baseArg)
  const meta: GitBaseMeta = (await readBaseMeta(baseDir)) ?? { repos: [] }
  const current = meta.ignore ?? []

  if (verb === 'list') {
    if (current.length === 0) {
      return {
        output: `Base "${baseName}" has no ignore patterns. Add some: ${cmd('base ignore add "tests/, **/*.spec.ts"', mode)}`,
      }
    }
    return {
      output: [`Ignore patterns for base "${baseName}":`, ...current.map(p => `  ${p}`)].join('\n'),
    }
  }

  if ((verb === 'add' || verb === 'remove' || verb === 'set') && patterns.length === 0) {
    throw new Error(`${cmd(`base ignore ${verb}`, mode)} requires at least one pattern.`)
  }

  let next: string[]
  switch (verb) {
    case 'add':
      next = normalizeIgnorePatterns([...current, ...patterns])
      break
    case 'remove': {
      const drop = new Set(patterns)
      next = current.filter(p => !drop.has(p))
      break
    }
    case 'set':
      next = normalizeIgnorePatterns(patterns)
      break
    default: // 'clear'
      next = []
      break
  }

  await writeBaseMeta(baseDir, { ...meta, ignore: next.length > 0 ? next : undefined })

  if (next.length === 0) {
    return { output: `Cleared ignore patterns for base "${baseName}".` }
  }
  return {
    output: [
      `Ignore patterns for base "${baseName}" (${next.length}):`,
      ...next.map(p => `  ${p}`),
      '',
      `Re-index to apply: ${cmd('scan', mode)}.`,
    ].join('\n'),
  }
}
