import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** One git remote tracked by a base. A base may track several. */
export interface GitRepoMeta {
  gitUrl: string
  gitBranch: string
  /** Stable provenance slug (also the `git_repo` value on facts from this repo). */
  slug: string
  /** Clone directory relative to the base dir (e.g. `repos/<slug>`; legacy bases use `repo`). */
  dir: string
  lastSyncedSha: string
  lastSyncedAt: string
}

export interface GitBaseMeta {
  repos: GitRepoMeta[]
  /**
   * Gitignore-style patterns for files/directories to skip while indexing this base.
   * Set via `kb init`'s prompt or `kb base set-ignore`; respected on init and every rescan.
   */
  ignore?: string[]
}

/** Legacy single-repo `meta.json` shape (pre multi-repo). Still read for back-compat. */
interface LegacyGitBaseMeta {
  gitUrl: string
  gitBranch: string
  lastSyncedSha: string
  lastSyncedAt: string
}

function metaPath(baseDir: string): string {
  return path.join(baseDir, 'meta.json')
}

function isLegacyMeta(value: unknown): value is LegacyGitBaseMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LegacyGitBaseMeta).gitUrl === 'string' &&
    !Array.isArray((value as { repos?: unknown }).repos)
  )
}

/**
 * Normalise a legacy single-repo `meta.json` into the multi-repo shape. The legacy
 * clone lives at `<baseDir>/repo/`, so the migrated entry keeps `dir: 'repo'` — no
 * re-clone needed. The slug is derived lazily here (kept in-process; written back on
 * the next `writeBaseMeta`).
 */
function normalizeMeta(parsed: unknown): GitBaseMeta | null {
  if (isLegacyMeta(parsed)) {
    return {
      repos: [
        {
          gitUrl: parsed.gitUrl,
          gitBranch: parsed.gitBranch,
          slug: repoSlugFromGitUrl(parsed.gitUrl),
          dir: 'repo',
          lastSyncedSha: parsed.lastSyncedSha,
          lastSyncedAt: parsed.lastSyncedAt,
        },
      ],
    }
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as GitBaseMeta).repos)
  ) {
    return parsed as GitBaseMeta
  }
  return null
}

export async function readBaseMeta(baseDir: string): Promise<GitBaseMeta | null> {
  try {
    const raw = await readFile(metaPath(baseDir), 'utf8')
    return normalizeMeta(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function writeBaseMeta(baseDir: string, meta: GitBaseMeta): Promise<void> {
  await writeFile(metaPath(baseDir), JSON.stringify(meta, null, 2), 'utf8')
}

/**
 * Derive a stable repo slug from a git remote URL. Reused as the clone dir name and
 * the `git_repo` provenance value on facts. Handles https and ssh remotes, as well as
 * local path / file:// remotes used in tests.
 */
export function repoSlugFromGitUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const pathPart = cleaned.includes('://')
    ? cleaned.split('/').slice(3).join('/') // https://host/org/repo → org/repo
    : cleaned.includes(':') && !cleaned.startsWith('/')
      ? (cleaned.split(':')[1] ?? cleaned) // git@host:org/repo → org/repo
      : cleaned // local path
  const parts = pathPart.split('/').filter(Boolean)
  const repo = parts.at(-1) ?? 'repo'
  const org = parts.at(-2)
  const slug = org ? `${org}-${repo}` : repo
  return slug.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'repo'
}

/** Clone directory (relative to the base dir) for a freshly-added repo. */
export function repoDirForSlug(slug: string): string {
  return path.join('repos', slug)
}
