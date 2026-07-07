import path from 'node:path'

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

/** Subdirectory (relative to a base dir) that holds the per-repo git clones. */
export const REPOS_SUBDIR = 'repos'

/** Clone directory (relative to the base dir) for a repo with the given slug. */
export function repoDirForSlug(slug: string): string {
  return path.join(REPOS_SUBDIR, slug)
}
