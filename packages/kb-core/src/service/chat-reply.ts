/**
 * Per-source resolution primitives for every surface that cites sources (Slack,
 * HTTP demo, CLI, MCP). Turns one `QuerySource` into a display label + optional
 * blob href against a per-repo registry.
 *
 * Grouping those into the source-centric footer (one line per file) lives in
 * `source-grouping.ts`, which builds on `resolveChatSourceDisplay` here.
 *
 * Blob links are per-repo: each indexed path's `slug` maps to that clone's
 * `gitUrl` + `gitBranch` from the base volume registry (`discoverBaseRepos`).
 * There is no global source branch — each repo's primary is the branch it was
 * cloned on (`url#branch`, `--branch`, or the remote's default HEAD).
 */

import { isOpenableSourcePath } from '@kb/core/core/fact-uri.js'
import { gitRemoteToBrowseUrl } from '@kb/core/ops/git-sync.js'
import { type BaseRepo, resolveBaseRepoRegistry } from '@kb/core/storage/base-repos.js'
import type { QuerySource } from './serialize.js'

export type ChatReplyFlavor = 'plain' | 'slack'

/** One tracked clone, ready for blob-link construction. */
export interface ChatSourceRepo {
  /** Local clone dir name and fact provenance tag. Infrastructure — never displayed. */
  slug: string
  /** HTTPS browse root (no trailing slash), e.g. `https://github.com/org/repo`. */
  browseUrl: string
  /** Clone HEAD branch — that repo's primary for blob links. */
  branch: string
  /** Public identity from the remote (`org/repo`) — the only repo name users see. */
  repoId: string
}

/**
 * Public repo identity (`org/repo`) from a browse root. The local clone dir name
 * is an artifact of how this node was provisioned (`rosenjcb-kb`,
 * `kb-2026-08-15-1419-kb`), so it must never appear in a citation.
 */
function repoIdFromBrowseUrl(browseUrl: string): string {
  try {
    return new URL(browseUrl).pathname.replace(/^\/+|\/+$/g, '')
  } catch {
    return ''
  }
}

export interface ChatReplyFormatOptions {
  /** `plain` = markdown-ish text; `slack` = Slack mrkdwn. */
  flavor?: ChatReplyFlavor
  /**
   * Per-repo registry from `discoverBaseRepos` / `chatSourceReposFromBaseRepos`.
   * Required for clickable blob links. Multi-repo: each source uses its own slug.
   */
  sourceRepos?: ChatSourceRepo[]
}

export interface ChatSourceDisplay {
  /**
   * Fully qualified `owner/repo/relPath` — the form every surface shows. Falls
   * back to bare `relPath` when no registry entry identifies the repo.
   */
  label: string
  /** `owner/repo` (GitHub `nameWithOwner`) when the repo is known. */
  repo?: string
  /** Repo-relative path on its own, for opening/grepping the file locally. */
  relPath: string
  /** Optional deep link (GitHub/GitLab blob URL, etc.). */
  href?: string
  symbol?: string
}

/**
 * Canonical one-call resolver every surface uses to get the blob-link registry
 * for a base: discover the base's tracked clones, then map them to browsable
 * entries. Surfaces (REST, MCP, CLI, demo, Slack) all call this so grouped
 * sources carry identical `href`s.
 */
export async function resolveSourceRepos(baseDir: string): Promise<ChatSourceRepo[]> {
  return chatSourceReposFromBaseRepos(await resolveBaseRepoRegistry(baseDir))
}

/** Build browsable source-repo entries from the base volume registry. */
export function chatSourceReposFromBaseRepos(repos: BaseRepo[]): ChatSourceRepo[] {
  const out: ChatSourceRepo[] = []
  for (const repo of repos) {
    const browseUrl = gitRemoteToBrowseUrl(repo.gitUrl)
    if (!browseUrl) continue
    const slug = repo.slug.trim()
    if (!slug) continue
    // A clone with no explicit branch (bare `HEAD`) still has a browsable default
    // branch on the forge: `…/blob/HEAD/<path>` resolves to it. Dropping these
    // left Slack (but not the demo, which defaults to `HEAD`) with unlinked
    // sources for the same base — so keep them and let `HEAD` stand in.
    const branch = (repo.gitBranch || '').trim() || 'HEAD'
    const repoId = repoIdFromBrowseUrl(browseUrl)
    if (!repoId) continue
    out.push({ slug, browseUrl, branch, repoId })
  }
  return out
}

function cleanPath(filePath: string | undefined): string | null {
  let p = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!p) return null
  if (p.startsWith('fact://')) return p
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('fact://')) return null
  p = p.replace(/#.*$/, '')
  if (!p) return null
  // Strip a leading repo slug for the openable check (`rosenjcb-kb/src-core-…`
  // is still a slug basename). Keep the full string as the return value.
  const segments = p.split('/')
  const withoutSlug = segments.length > 1 ? segments.slice(1).join('/') : p
  if (!isOpenableSourcePath(withoutSlug) && !isOpenableSourcePath(p)) return null
  return p
}

/**
 * Resolve display label + optional blob href for one source against the
 * per-repo registry. Prefer `source.gitRepo`; else match the first path segment
 * to a known slug.
 */
export function resolveChatSourceDisplay(
  source: QuerySource,
  sourceRepos: ChatSourceRepo[] = [],
): ChatSourceDisplay | null {
  const raw = cleanPath(source.filePath || source.title || source.id)
  if (!raw) return null

  if (raw.startsWith('fact://')) {
    return {
      label: raw,
      relPath: raw,
      ...(source.symbol ? { symbol: source.symbol } : {}),
    }
  }

  const bySlug = new Map(sourceRepos.map(r => [r.slug, r]))
  const hinted = (source.gitRepo || '').trim()
  const firstSeg = raw.split('/')[0] || ''
  const slug =
    (hinted && bySlug.has(hinted) ? hinted : undefined) ||
    (firstSeg && bySlug.has(firstSeg) ? firstSeg : undefined)
  const repo = slug ? bySlug.get(slug) : undefined

  // Strip the clone dir name whether or not the registry resolved it. `gitRepo` is
  // the fact's provenance tag, so an unregistered clone still yields a clean
  // repo-relative path instead of leaking `kb-2026-08-15-1419-kb/…` to the user.
  const prefix = slug || (hinted && raw.startsWith(`${hinted}/`) ? hinted : '')
  let relPath = raw
  if (prefix && raw === prefix) {
    relPath = ''
  } else if (prefix && raw.startsWith(`${prefix}/`)) {
    relPath = raw.slice(prefix.length + 1)
  }

  if (!relPath) return null

  // Always `owner/repo/relPath` (GitHub `nameWithOwner` + path) — a base can hold
  // many repos, so an unqualified path does not say which one it came from. The
  // clone dir name is never a component. No registry entry → bare path, which is
  // the most that can honestly be said about it.
  const label = repo ? `${repo.repoId}/${relPath}` : relPath

  let href: string | undefined
  if (repo && relPath) {
    const encoded = relPath
      .split('/')
      .map(seg => encodeURIComponent(seg))
      .join('/')
    href = `${repo.browseUrl}/blob/${encodeURIComponent(repo.branch)}/${encoded}`
  }

  return {
    label,
    ...(repo ? { repo: repo.repoId } : {}),
    relPath,
    ...(href ? { href } : {}),
    ...(source.symbol ? { symbol: source.symbol } : {}),
  }
}

/** @deprecated Prefer {@link resolveChatSourceDisplay} with `sourceRepos`. */
export function repoRelativeSourcePath(
  filePath: string | undefined,
  stripPrefixes: string[] = [],
): string | null {
  const cleaned = cleanPath(filePath)
  if (!cleaned || cleaned.startsWith('fact://')) return cleaned
  let p = cleaned
  for (const raw of stripPrefixes) {
    const prefix = raw.replace(/\/+$/, '')
    if (!prefix) continue
    if (p === prefix) return null
    if (p.startsWith(`${prefix}/`)) {
      p = p.slice(prefix.length + 1)
      break
    }
  }
  return p || null
}

// Grouped (source-centric) footer + reply rendering lives in `source-grouping.ts`
// (`formatGroupedSourcesFooter`, `formatGroupedChatReply`). This module keeps only
// the per-source resolution primitives those renderers build on.
