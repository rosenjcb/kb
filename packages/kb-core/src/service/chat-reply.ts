/**
 * Shared chat-reply presentation for every surface that consumes
 * `streamChatTurn` / `service.chat` answer events (Slack, HTTP demo, etc.).
 *
 * The wire contract stays structured (`answer` + `sources[]`); this module turns
 * that payload into a user-visible message with a deduped Sources footer.
 *
 * Blob links are per-repo: each indexed path's `slug` maps to that clone's
 * `gitUrl` + `gitBranch` from the base volume registry (`discoverBaseRepos`).
 * There is no global source branch — each repo's primary is the branch it was
 * cloned on (`url#branch`, `--branch`, or the remote's default HEAD).
 */

import { gitRemoteToBrowseUrl } from '@kb/core/ops/git-sync.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'
import { markdownToSlackMrkdwn } from './markdown-to-slack.js'
import type { QuerySource } from './serialize.js'

export type ChatReplyFlavor = 'plain' | 'slack'

/** One tracked clone, ready for blob-link construction. */
export interface ChatSourceRepo {
  slug: string
  /** HTTPS browse root (no trailing slash), e.g. `https://github.com/org/repo`. */
  browseUrl: string
  /** Clone HEAD branch — that repo's primary for blob links. */
  branch: string
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
  /** Repo-relative (or `slug/path` when multi-repo) label shown to the user. */
  label: string
  /** Optional deep link (GitHub/GitLab blob URL, etc.). */
  href?: string
  symbol?: string
}

/** Build browsable source-repo entries from the base volume registry. */
export function chatSourceReposFromBaseRepos(repos: BaseRepo[]): ChatSourceRepo[] {
  const out: ChatSourceRepo[] = []
  for (const repo of repos) {
    const browseUrl = gitRemoteToBrowseUrl(repo.gitUrl)
    if (!browseUrl) continue
    const branch = (repo.gitBranch || '').trim()
    if (!branch || branch === 'HEAD') continue
    const slug = repo.slug.trim()
    if (!slug) continue
    out.push({ slug, browseUrl, branch })
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
  return p || null
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
      ...(source.symbol ? { symbol: source.symbol } : {}),
    }
  }

  const bySlug = new Map(sourceRepos.map(r => [r.slug, r]))
  const multi = sourceRepos.length > 1
  const hinted = (source.gitRepo || '').trim()
  const firstSeg = raw.split('/')[0] || ''
  const slug =
    (hinted && bySlug.has(hinted) ? hinted : undefined) ||
    (firstSeg && bySlug.has(firstSeg) ? firstSeg : undefined)
  const repo = slug ? bySlug.get(slug) : undefined

  let relPath = raw
  if (slug && raw === slug) {
    relPath = ''
  } else if (slug && raw.startsWith(`${slug}/`)) {
    relPath = raw.slice(slug.length + 1)
  }

  if (!relPath && !slug) return null

  const label =
    slug && multi && relPath
      ? `${slug}/${relPath}`
      : relPath || slug || raw

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

export function normalizeChatSources(
  sources: QuerySource[] | undefined,
  options: ChatReplyFormatOptions = {},
): ChatSourceDisplay[] {
  const sourceRepos = options.sourceRepos ?? []
  const seen = new Set<string>()
  const out: ChatSourceDisplay[] = []

  for (const src of sources ?? []) {
    const display = resolveChatSourceDisplay(src, sourceRepos)
    if (!display) continue
    const key = `${display.label.toLowerCase()}#${(display.symbol || '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(display)
  }
  return out
}

function formatSourceLine(
  index: number,
  source: ChatSourceDisplay,
  flavor: ChatReplyFlavor,
): string {
  const suffix = source.symbol ? ` · ${source.symbol}` : ''
  if (flavor === 'slack') {
    if (source.href) {
      return `${index}. <${source.href}|${source.label}>${suffix}`
    }
    return `${index}. \`${source.label}\`${suffix}`
  }
  if (source.href) {
    return `${index}. [${source.label}](${source.href})${suffix}`
  }
  return `${index}. ${source.label}${suffix}`
}

/** Sources footer only (empty string when nothing to show). */
export function formatChatSourcesFooter(
  sources: QuerySource[] | undefined,
  options: ChatReplyFormatOptions = {},
): string {
  const normalized = normalizeChatSources(sources, options)
  if (normalized.length === 0) return ''
  const flavor = options.flavor ?? 'plain'
  const header = flavor === 'slack' ? '*Sources*' : 'Sources'
  const lines = normalized.map((s, i) => formatSourceLine(i + 1, s, flavor))
  return `${header}\n${lines.join('\n')}`
}

/**
 * Full user-visible chat reply: answer body + optional Sources footer.
 * Same shape Slack and other text surfaces should post.
 *
 * When `flavor: 'slack'`, the answer body is run through
 * {@link markdownToSlackMrkdwn} so model Markdown (headers, tables, `**bold**`)
 * becomes Slack mrkdwn before posting.
 */
export function formatChatReply(
  answer: string,
  sources?: QuerySource[],
  options: ChatReplyFormatOptions = {},
): string {
  const flavor = options.flavor ?? 'plain'
  let body = answer.trim()
  if (flavor === 'slack' && body) {
    body = markdownToSlackMrkdwn(body)
  }
  const footer = formatChatSourcesFooter(sources, options)
  if (!footer) return body
  if (!body) return footer
  return `${body}\n\n${footer}`
}
