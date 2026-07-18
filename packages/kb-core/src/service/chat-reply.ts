/**
 * Shared chat-reply presentation for every surface that consumes
 * `streamChatTurn` / `service.chat` answer events (Slack, HTTP demo, etc.).
 *
 * The wire contract stays structured (`answer` + `sources[]`); this module turns
 * that payload into a user-visible message with a deduped Sources footer.
 */

import { markdownToSlackMrkdwn } from './markdown-to-slack.js'
import type { QuerySource } from './serialize.js'

export type ChatReplyFlavor = 'plain' | 'slack'

export interface ChatReplyFormatOptions {
  /** `plain` = markdown-ish text; `slack` = Slack mrkdwn. */
  flavor?: ChatReplyFlavor
  /**
   * When set, file sources link to `{sourceRepoUrl}/blob/{sourceBranch}/{path}`.
   * Slack uses `<url|label>`; plain uses markdown links.
   */
  sourceRepoUrl?: string
  sourceBranch?: string
  /**
   * Leading path segments to strip (indexed form is often `<gitRepo>/<relPath>`).
   * Compared case-sensitively against the first path segment.
   */
  stripPrefixes?: string[]
}

export interface ChatSourceDisplay {
  /** Repo-relative (or fact://) label shown to the user. */
  label: string
  /** Optional deep link (GitHub blob URL, etc.). */
  href?: string
  symbol?: string
}

const DEFAULT_STRIP = ['rosenjcb-kb', 'kb']

/** Strip index/git-repo prefix → display path, or null when not a usable source. */
export function repoRelativeSourcePath(
  filePath: string | undefined,
  stripPrefixes: string[] = DEFAULT_STRIP,
): string | null {
  let p = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!p) return null
  if (p.startsWith('fact://')) return p
  // Scheme-like at the start only (http:, replace:, …) — not mid-path colons.
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('fact://')) return null

  for (const raw of stripPrefixes) {
    const prefix = raw.replace(/\/+$/, '')
    if (!prefix) continue
    if (p === prefix) return null
    if (p.startsWith(`${prefix}/`)) {
      p = p.slice(prefix.length + 1)
      break
    }
  }
  p = p.replace(/#.*$/, '')
  return p || null
}

export function normalizeChatSources(
  sources: QuerySource[] | undefined,
  options: ChatReplyFormatOptions = {},
): ChatSourceDisplay[] {
  const strip = options.stripPrefixes?.length ? options.stripPrefixes : DEFAULT_STRIP
  const repo = (options.sourceRepoUrl || '').trim().replace(/\/+$/, '')
  const branch = (options.sourceBranch || 'main').trim() || 'main'
  const seen = new Set<string>()
  const out: ChatSourceDisplay[] = []

  for (const src of sources ?? []) {
    const raw = src.filePath || src.title || src.id || ''
    const label = repoRelativeSourcePath(raw, strip) || raw || 'unknown'
    const key = `${label.toLowerCase()}#${(src.symbol || '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    let href: string | undefined
    if (repo && label && !label.startsWith('fact://') && !/^[a-z][a-z0-9+.-]*:/i.test(label)) {
      href = `${repo}/blob/${branch}/${label
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/')}`
    }

    out.push({
      label,
      ...(href ? { href } : {}),
      ...(src.symbol ? { symbol: src.symbol } : {}),
    })
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
