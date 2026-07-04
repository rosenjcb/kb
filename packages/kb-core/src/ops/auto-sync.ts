import path from 'node:path'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { type GitRepoMeta, readBaseMeta, writeBaseMeta } from '@kb/core/storage/base-meta.js'
import { getHeadSha, pullRepo } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'

const DEFAULT_STALE_MS = 30 * 60 * 1000 // 30 minutes

export interface AutoSyncOptions {
  onProgress?: (line: string) => void
  staleLimitMs?: number
  /** Force a pull + re-index of every repo regardless of recency or new commits (`kb scan`). */
  force?: boolean
}

interface RepoSyncOutcome {
  repo: GitRepoMeta
  reindexed: boolean
}

/** Re-index `repo` from its clone, tagging facts with its slug. */
async function reindexRepo(baseDir: string, repo: GitRepoMeta): Promise<void> {
  await runKbInit({
    base: path.basename(baseDir),
    cwd: path.join(baseDir, repo.dir),
    rescan: true,
    apply: true,
    nonInteractive: true,
    gitRepo: repo.slug,
  })
}

/**
 * Pull + (conditionally) re-index a single repo. Returns the updated meta entry and whether
 * the index changed. Never throws — git/index failures are logged and the repo is left as-is.
 */
async function syncRepo(
  baseDir: string,
  repo: GitRepoMeta,
  opts: AutoSyncOptions
): Promise<RepoSyncOutcome> {
  const { onProgress } = opts
  const repoDir = path.join(baseDir, repo.dir)

  let hadNewCommits: boolean
  try {
    hadNewCommits = await pullRepo(repoDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Sync skipped for ${repo.slug} (git pull failed): ${msg}`)
    return { repo, reindexed: false }
  }

  const newSha = await getHeadSha(repoDir)
  if (!hadNewCommits && !opts.force) {
    return { repo: { ...repo, lastSyncedAt: new Date().toISOString() }, reindexed: false }
  }

  onProgress?.(`[kb] ${repo.slug}: re-indexing (→ ${newSha.slice(0, 8)})…`)
  try {
    await reindexRepo(baseDir, repo)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Re-index failed for ${repo.slug}: ${msg}`)
    return { repo, reindexed: false }
  }

  onProgress?.(`[kb] ${repo.slug}: indexed up to ${newSha.slice(0, 8)}.`)
  return {
    repo: { ...repo, lastSyncedSha: newSha, lastSyncedAt: new Date().toISOString() },
    reindexed: true,
  }
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
 * If `baseDir` tracks git repos (i.e. was created with `kb init --git`), pull each remote and
 * re-index any with new commits when the last sync is older than `staleLimitMs` (default 30
 * min). Pass `staleLimitMs: 0` to always pull regardless of recency (session load / `kb base
 * use`). No-ops for bases without a `meta.json`. Never throws.
 */
export async function maybeAutoSync(baseDir: string, opts: AutoSyncOptions = {}): Promise<void> {
  const meta = await readBaseMeta(baseDir)
  if (!meta || meta.repos.length === 0) return

  const staleLimitMs = opts.staleLimitMs ?? DEFAULT_STALE_MS
  const updated: GitRepoMeta[] = []
  let anyReindexed = false
  let anyTouched = false

  for (const repo of meta.repos) {
    const lastSyncMs = new Date(repo.lastSyncedAt).getTime()
    if (!opts.force && Date.now() - lastSyncMs < staleLimitMs) {
      updated.push(repo)
      continue
    }
    anyTouched = true
    opts.onProgress?.(`[kb] Auto-syncing ${repo.slug} from ${repo.gitUrl}…`)
    const outcome = await syncRepo(baseDir, repo, opts)
    updated.push(outcome.repo)
    anyReindexed = anyReindexed || outcome.reindexed
  }

  if (anyReindexed) reconcile(baseDir, opts.onProgress)
  if (anyTouched) await writeBaseMeta(baseDir, { ...meta, repos: updated })
}

/**
 * `kb scan`: force a pull + re-index of every repo tracked by the base, then reconcile.
 * Unlike `maybeAutoSync`, this re-indexes regardless of recency or new commits.
 */
export async function scanBaseRepos(baseDir: string, opts: AutoSyncOptions = {}): Promise<void> {
  await maybeAutoSync(baseDir, { ...opts, force: true, staleLimitMs: 0 })
}
