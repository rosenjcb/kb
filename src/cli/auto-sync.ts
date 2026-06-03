import path from 'node:path'
import { readBaseMeta, writeBaseMeta } from './base-meta'
import { getHeadSha, pullRepo } from './git-sync'
import { runKbInit } from './init-cli'

const DEFAULT_STALE_MS = 30 * 60 * 1000 // 30 minutes

export interface AutoSyncOptions {
  onProgress?: (line: string) => void
  staleLimitMs?: number
}

/**
 * If `baseDir` has a `meta.json` (i.e. was created with `kb init --git`),
 * pull from the remote and rescan if the last sync is older than `staleLimitMs`.
 * No-ops for local bases.
 */
export async function maybeAutoSync(baseDir: string, opts: AutoSyncOptions = {}): Promise<void> {
  const meta = await readBaseMeta(baseDir)
  if (!meta) return

  const staleLimitMs = opts.staleLimitMs ?? DEFAULT_STALE_MS
  const lastSyncMs = new Date(meta.lastSyncedAt).getTime()
  if (Date.now() - lastSyncMs < staleLimitMs) return

  const repoDir = path.join(baseDir, 'repo')
  const { onProgress } = opts

  onProgress?.(`[kb] Auto-syncing from ${meta.gitUrl}…`)

  let hadNewCommits: boolean
  try {
    hadNewCommits = await pullRepo(repoDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Auto-sync skipped (git pull failed): ${msg}`)
    return
  }

  const newSha = await getHeadSha(repoDir)

  if (!hadNewCommits) {
    await writeBaseMeta(baseDir, { ...meta, lastSyncedAt: new Date().toISOString() })
    return
  }

  onProgress?.(`[kb] New commits (→ ${newSha.slice(0, 8)}). Re-indexing…`)

  try {
    await runKbInit({
      base: path.basename(baseDir),
      cwd: repoDir,
      rescan: true,
      apply: true,
      nonInteractive: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.(`[kb] Re-index failed: ${msg}`)
    return
  }

  await writeBaseMeta(baseDir, {
    ...meta,
    lastSyncedSha: newSha,
    lastSyncedAt: new Date().toISOString(),
  })

  onProgress?.(`[kb] Indexed up to ${newSha.slice(0, 8)}.`)
}
