/**
 * `kb base add-repo|remove-repo|list-repos` — manage the git repos a base tracks.
 *
 * The repo list lives in the base's `meta.json` (not the global config). Adding clones +
 * indexes the repo into the one base graph; removing purges its facts and clone. After any
 * mutation we re-run cross-repo reconciliation so the graph stays one connected tree.
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

export interface RepoCommandResult {
  output: string
}

export interface RunRepoCommandOptions {
  mode?: CmdMode
  onProgress?: (line: string) => void
}

export type RepoAction = 'add-repo' | 'remove-repo' | 'list-repos'

export function isRepoAction(action: string | undefined): action is RepoAction {
  return action === 'add-repo' || action === 'remove-repo' || action === 'list-repos'
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

export async function runRepoCommand(
  action: RepoAction,
  args: string[],
  options: RunRepoCommandOptions = {}
): Promise<RepoCommandResult> {
  const mode = options.mode ?? 'cli'
  const baseArg = readOption(args, '--base')
  const positional = args.filter(a => !a.startsWith('--'))
  // Drop a value that belongs to --base from the positionals.
  const target = positional.find(p => p !== baseArg)

  if (action === 'list-repos') {
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

  if (action === 'add-repo') {
    if (!target) {
      throw new Error(`${cmd('base add-repo', mode)} requires a git URL (optionally url#branch)`)
    }
    const branch = readOption(args, '--branch')
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
    await writeBaseMeta(baseDir, { repos: [...meta.repos, entry] })
    reconcile(baseDir, options.onProgress)
    return { output: `Added repo "${slug}" to base "${baseName}".` }
  }

  // remove-repo
  if (!target) {
    throw new Error(`${cmd('base remove-repo', mode)} requires a git URL or repo slug`)
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
  await writeBaseMeta(baseDir, { repos: meta.repos.filter(r => r.slug !== repo.slug) })
  return {
    output: `Removed repo "${repo.slug}" from base "${baseName}" (purged ${removedFacts} fact(s)).`,
  }
}
