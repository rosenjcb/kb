/**
 * Repo registry, derived from the clones on a base's volume.
 *
 * The git clones under `<baseDir>/repos/*` ARE a base's repo registry. Each clone's
 * `origin` remote is the durable record of where it came from, so nothing needs to be
 * persisted alongside it — the boot env declares what to clone, and from then on the
 * volume is self-describing. `slug` is the clone dir name (kept in step with
 * `repoDirForSlug`), which is also the `git_repo` provenance tag on every fact indexed
 * from that repo.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { getCurrentBranch, getHeadSha, getRemoteUrl } from '@kb/core/ops/git-sync.js'
import { REPOS_SUBDIR } from '@kb/core/storage/repo-slug.js'
import { readSnapshotManifest } from '@kb/core/storage/snapshot.js'

/** One git clone tracked by a base, as read back off the volume. */
export interface BaseRepo {
  gitUrl: string
  gitBranch: string
  /** Stable provenance slug (also the clone dir name and the `git_repo` value on facts). */
  slug: string
  /** Clone directory relative to the base dir (`repos/<slug>`). */
  dir: string
  /** Full SHA of the clone's HEAD — the commit the index reflects (undefined if unreadable). */
  headSha?: string
}

/**
 * Enumerate the git clones under `<baseDir>/repos/*` as the base's tracked-repo registry.
 * Missing/empty `repos/` dir → no repos. Non-git or unreadable entries are skipped.
 */
export async function discoverBaseRepos(baseDir: string): Promise<BaseRepo[]> {
  const reposDir = path.join(baseDir, REPOS_SUBDIR)
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    const raw = await readdir(reposDir, { withFileTypes: true })
    entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return []
  }

  const repos: BaseRepo[] = []
  for (const entry of entries) {
    if (!entry.isDir) continue
    const repoDir = path.join(reposDir, entry.name)
    if (!existsSync(path.join(repoDir, '.git'))) continue
    try {
      const gitUrl = await getRemoteUrl(repoDir)
      const gitBranch = await getCurrentBranch(repoDir)
      // headSha is optional provenance (used to reconcile a re-clone) — a repo
      // stays tracked even when the commit can't be read.
      let headSha: string | undefined
      try {
        headSha = await getHeadSha(repoDir)
      } catch {
        headSha = undefined
      }
      repos.push({
        gitUrl,
        gitBranch,
        slug: entry.name,
        dir: path.join(REPOS_SUBDIR, entry.name),
        ...(headSha ? { headSha } : {}),
      })
    } catch {
      // Not a readable clone (no origin remote, detached, …) — skip it.
    }
  }
  return repos
}

/**
 * The base's tracked-repo registry for **every** consumer (citations, `/v1/bases`,
 * scan). Live clones first; a snapshot manifest's provenance when the base carries
 * no clones.
 *
 * A serve-only node hydrates from a snapshot and prunes `repos/*`, so
 * {@link discoverBaseRepos} alone returns `[]` there and every citation silently
 * loses its blob link. The manifest recorded the same `{gitUrl, gitBranch, slug}`
 * at export time, so it stands in exactly.
 */
export async function resolveBaseRepoRegistry(baseDir: string): Promise<BaseRepo[]> {
  const clones = await discoverBaseRepos(baseDir)
  if (clones.length > 0) return clones
  let manifest: Awaited<ReturnType<typeof readSnapshotManifest>>
  try {
    manifest = await readSnapshotManifest(baseDir)
  } catch {
    return []
  }
  return (manifest?.provenance.repos ?? []).map(repo => ({
    gitUrl: repo.gitUrl,
    gitBranch: repo.gitBranch,
    slug: repo.slug,
    dir: path.join(REPOS_SUBDIR, repo.slug),
    ...(repo.headSha ? { headSha: repo.headSha } : {}),
  }))
}
