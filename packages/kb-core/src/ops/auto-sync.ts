import path from 'node:path'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { type BaseRepo, discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import { readIgnorePatternsFromEnv } from '@kb/core/config/kb-ignore.js'
import { getHeadSha, pullRepo } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'

export interface ScanOptions {
  onProgress?: (line: string) => void
}

/** Re-index `repo` from its clone, tagging facts with its slug. Ignore patterns come from env. */
async function reindexRepo(baseDir: string, repo: BaseRepo): Promise<void> {
  await runKbInit({
    base: path.basename(baseDir),
    cwd: path.join(baseDir, repo.dir),
    rescan: true,
    apply: true,
    nonInteractive: true,
    gitRepo: repo.slug,
    ignorePatterns: readIgnorePatternsFromEnv(),
  })
}

/**
 * Pull + (conditionally) re-index a single repo. Returns whether the index changed. Never
 * throws — git/index failures are logged and the repo is left as-is. `force` re-indexes even
 * when the pull brought no new commits.
 */
async function syncRepo(baseDir: string, repo: BaseRepo, opts: ScanOptions): Promise<boolean> {
  const { onProgress } = opts
  const repoDir = path.join(baseDir, repo.dir)

  let hadNewCommits: boolean
  try {
    hadNewCommits = await pullRepo(repoDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Sync skipped for ${repo.slug} (git pull failed): ${msg}`)
    return false
  }

  const newSha = await getHeadSha(repoDir)
  if (!hadNewCommits) return false

  onProgress?.(`[kb] ${repo.slug}: re-indexing (→ ${newSha.slice(0, 8)})…`)
  try {
    await reindexRepo(baseDir, repo)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Re-index failed for ${repo.slug}: ${msg}`)
    return false
  }

  onProgress?.(`[kb] ${repo.slug}: indexed up to ${newSha.slice(0, 8)}.`)
  return true
}

/** Rebuild the cross-repo bridge edges after one or more repos changed. */
function reconcile(baseDir: string, onProgress?: (line: string) => void): void {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    const linked = indexer.reconcileCrossRepoEdges()
    if (linked > 0) onProgress?.(`[kb] Linked ${linked} cross-repo edge(s).`)
  } finally {
    indexer.close()
  }
}

/**
 * Pull every git clone on the base's volume and re-index any with new commits, then rebuild
 * the cross-repo graph. The clones under `<baseDir>/repos/*` are the tracked-repo registry
 * (see `discoverBaseRepos`); nothing is persisted about sync state — the reindex scheduler
 * owns cadence, and each clone's HEAD is its own source of truth. Never throws.
 */
export async function scanBaseRepos(baseDir: string, opts: ScanOptions = {}): Promise<number> {
  const repos = await discoverBaseRepos(baseDir)
  if (repos.length === 0) return 0

  let anyReindexed = false
  for (const repo of repos) {
    opts.onProgress?.(`[kb] Syncing ${repo.slug} from ${repo.gitUrl}…`)
    const reindexed = await syncRepo(baseDir, repo, opts)
    anyReindexed = anyReindexed || reindexed
  }

  if (anyReindexed) reconcile(baseDir, opts.onProgress)
  return repos.length
}
