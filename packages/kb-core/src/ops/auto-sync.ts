import { existsSync } from 'node:fs'
import path from 'node:path'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { createEmbedder } from '@kb/core/core/embeddings.js'
import { type BaseRepo, discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import { readIgnorePatternsFromEnv } from '@kb/core/config/kb-ignore.js'
import { HARVEST_PIPELINE_VERSION, isPipelineStale } from '@kb/core/core/pipeline-version.js'
import { getHeadSha, pullRepo } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'

export interface ScanOptions {
  onProgress?: (line: string) => void
  /** Skip embedding entirely — see `InitOptions.skipEmbeddings`. Propagated to every per-repo
   *  reindex and to the trailing base-wide embed pass below. */
  skipEmbeddings?: boolean
}

/**
 * True when this repo's slice of the index was built by an older extraction pipeline.
 * Best-effort: an unreadable index is not a reason to force a rebuild loop, so any
 * failure reads as "not stale" and the commit-based trigger stays in charge.
 */
function isRepoPipelineStale(baseDir: string, slug: string): boolean {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) return false
  try {
    const indexer = new SqliteKbIndexer({ dbPath })
    try {
      return isPipelineStale(indexer, slug)
    } finally {
      indexer.close()
    }
  } catch {
    return false
  }
}

/** Re-index `repo` from its clone, tagging facts with its slug. Ignore patterns come from env. */
async function reindexRepo(
  baseDir: string,
  repo: BaseRepo,
  skipEmbeddings?: boolean
): Promise<void> {
  await runKbInit({
    base: path.basename(baseDir),
    cwd: path.join(baseDir, repo.dir),
    rescan: true,
    apply: true,
    nonInteractive: true,
    gitRepo: repo.slug,
    ignorePatterns: readIgnorePatternsFromEnv(),
    skipEmbeddings,
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
  // Upstream commits are not the only reason an index is out of date: when KB's own
  // extraction changes, a repo that never moves keeps a stale index indefinitely. The
  // pipeline stamp catches that case, so shipping a new harvester actually reaches the
  // fleet instead of waiting on unrelated upstream activity.
  const pipelineStale = isRepoPipelineStale(baseDir, repo.slug)
  if (!hadNewCommits && !pipelineStale) return false

  const reason = hadNewCommits
    ? `→ ${newSha.slice(0, 8)}`
    : `pipeline v${HARVEST_PIPELINE_VERSION} rebuild`
  onProgress?.(`[kb] ${repo.slug}: re-indexing (${reason})…`)
  try {
    await reindexRepo(baseDir, repo, opts.skipEmbeddings)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Re-index failed for ${repo.slug}: ${msg}`)
    return false
  }

  onProgress?.(`[kb] ${repo.slug}: indexed up to ${newSha.slice(0, 8)}.`)
  return true
}

/**
 * Embed whatever the re-index just wrote. The per-repo rescan path skips embedding (it has no
 * view of the whole base), so without this the newly indexed documents and symbols would only
 * be reachable through the lexical lane. Throws on failure — a rescan that reports success
 * without vectors would leave the base's semantic lane silently stale.
 */
async function embedNewRows(baseDir: string, onProgress?: (line: string) => void): Promise<void> {
  const embedder = createEmbedder()
  const indexer = new SqliteKbIndexer({
    dbPath: path.join(baseDir, '.kb-index.sqlite'),
    embedder,
  })
  try {
    const documents = await indexer.embedAllDocuments()
    const symbols = await indexer.embedAllCodeSymbols()
    const facts = await indexer.embedAllFacts()
    if (documents + symbols + facts > 0) {
      onProgress?.(
        `[kb] Embedded ${documents} document(s), ${symbols} symbol(s), ${facts} fact(s).`
      )
    }
  } finally {
    indexer.close()
  }
}

/**
 * Pull every git clone on the base's volume and re-index any with new commits, then embed
 * whatever changed. The clones under `<baseDir>/repos/*` are the tracked-repo registry
 * (see `discoverBaseRepos`); nothing is persisted about sync state — the reindex scheduler
 * owns cadence, and each clone's HEAD is its own source of truth. The per-repo sync loop
 * itself never throws (`syncRepo` catches and reports failures per repo), but the trailing
 * embed step does: a caller must not treat a successful return as "vectors are current" —
 * unless `opts.skipEmbeddings` was set, in which case no embedding was attempted at all.
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

  if (anyReindexed && !opts.skipEmbeddings) await embedNewRows(baseDir, opts.onProgress)
  return repos.length
}
