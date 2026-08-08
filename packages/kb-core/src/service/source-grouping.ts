/**
 * Canonical source-centric citation model shared by every surface (demo, Slack,
 * CLI, MCP, REST).
 *
 * Historically each surface ranked and rendered *facts* (one row per symbol), so
 * the same file recurred once per symbol, non-openable refs (`fact://…`,
 * `edge:<sha>`) leaked in as bogus filenames, and each surface deduped/linked
 * differently. This module collapses the ranked fact list into a ranked list of
 * **files**, each carrying its folded fact subjects (symbols) — one shape, built
 * once, rendered everywhere.
 *
 * Openable-only: a citation you cannot open is noise, so anything that resolves
 * to no physical file (`fact://` ids, scheme URIs) is dropped here.
 */

import { type ChatReplyFlavor, type ChatSourceRepo, resolveChatSourceDisplay } from './chat-reply.js'
import { markdownToSlackMrkdwn } from './markdown-to-slack.js'
import type { QuerySource } from './serialize.js'

/** Default ceiling on cited files for user-facing surfaces (demo, Slack, CLI). */
export const DEFAULT_SOURCE_LIMIT = 20
/** Default cap on folded fact subjects shown per file. */
export const DEFAULT_MAX_SYMBOLS_PER_SOURCE = 6

/** One underlying fact folded under its file (richer payload for query responses). */
export interface GroupedSourceFact {
  id?: string
  symbol?: string
  snippet?: string
}

/** One cited file with its folded fact subjects. */
export interface GroupedSource {
  /** Openable repo-relative (or `slug/relPath` when multi-repo) path. */
  path: string
  /** Origin repo slug when known. */
  gitRepo?: string
  /** Display label (same as `path` today; kept distinct for future divergence). */
  label: string
  /** Blob deep link when a repo registry resolved one. */
  href?: string
  /** Distinct fact subjects (symbols), rank-order preserved, capped. */
  symbols: string[]
  /** Underlying facts, for verbose/REST consumers. */
  facts: GroupedSourceFact[]
  /** Total facts that mapped to this file (may exceed `facts.length` when capped). */
  factCount: number
}

export interface GroupSourcesOptions {
  /** Per-repo registry for blob-link construction (from `chatSourceReposFromBaseRepos`). */
  sourceRepos?: ChatSourceRepo[]
  /** Max files to return. Defaults to {@link DEFAULT_SOURCE_LIMIT}. */
  maxSources?: number
  /** Max folded symbols per file. Defaults to {@link DEFAULT_MAX_SYMBOLS_PER_SOURCE}. */
  maxSymbolsPerSource?: number
}

/**
 * Collapse a rank-ordered `QuerySource[]` (one row per fact) into a rank-ordered
 * `GroupedSource[]` (one row per file). Dedupes by resolved path, folds symbols
 * and facts under each file, drops non-openable refs, and caps the list.
 *
 * The incoming order is the retrieval ranking; relevance gating already happened
 * upstream (min-score + fact curator), so fewer relevant facts → fewer files.
 */
export function groupSources(
  sources: QuerySource[] | undefined,
  options: GroupSourcesOptions = {}
): GroupedSource[] {
  const sourceRepos = options.sourceRepos ?? []
  const maxSources = options.maxSources ?? DEFAULT_SOURCE_LIMIT
  const maxSymbols = options.maxSymbolsPerSource ?? DEFAULT_MAX_SYMBOLS_PER_SOURCE

  const byPath = new Map<string, GroupedSource>()

  for (const src of sources ?? []) {
    const display = resolveChatSourceDisplay(src, sourceRepos)
    if (!display) continue
    // Non-openable citation (`fact://<hex>` fallback id) — never a useful source.
    if (display.label.startsWith('fact://')) continue

    const key = display.label.toLowerCase()
    let group = byPath.get(key)
    if (!group) {
      // Ceiling reached — ignore new files, but keep folding facts into files
      // already cited (handled below for existing groups).
      if (byPath.size >= maxSources) continue
      group = {
        path: display.label,
        ...(src.gitRepo ? { gitRepo: src.gitRepo } : {}),
        label: display.label,
        ...(display.href ? { href: display.href } : {}),
        symbols: [],
        facts: [],
        factCount: 0,
      }
      byPath.set(key, group)
    }

    const symbol = display.symbol?.trim() || src.symbol?.trim()
    if (
      symbol &&
      group.symbols.length < maxSymbols &&
      !group.symbols.some(s => s.toLowerCase() === symbol.toLowerCase())
    ) {
      group.symbols.push(symbol)
    }
    group.facts.push({
      ...(src.id ? { id: src.id } : {}),
      ...(symbol ? { symbol } : {}),
      ...(src.snippet ? { snippet: src.snippet } : {}),
    })
    group.factCount += 1
  }

  return [...byPath.values()].slice(0, maxSources)
}

/** One grouped-source line: `N. <label>  · sym1, sym2` (flavor-specific link syntax). */
function formatGroupedSourceLine(
  index: number,
  source: GroupedSource,
  flavor: ChatReplyFlavor
): string {
  const suffix = source.symbols.length > 0 ? ` · ${source.symbols.join(', ')}` : ''
  if (flavor === 'slack') {
    return source.href
      ? `${index}. <${source.href}|${source.label}>${suffix}`
      : `${index}. \`${source.label}\`${suffix}`
  }
  return source.href
    ? `${index}. [${source.label}](${source.href})${suffix}`
    : `${index}. ${source.label}${suffix}`
}

/** Sources footer only (empty string when nothing to show). */
export function formatGroupedSourcesFooter(
  sources: GroupedSource[] | undefined,
  flavor: ChatReplyFlavor = 'plain'
): string {
  const grouped = sources ?? []
  if (grouped.length === 0) return ''
  const header = flavor === 'slack' ? '*Sources*' : 'Sources'
  const lines = grouped.map((s, i) => formatGroupedSourceLine(i + 1, s, flavor))
  return `${header}\n${lines.join('\n')}`
}

/**
 * Full user-visible chat reply: answer body + optional source-centric footer.
 * The same shape Slack and the HTTP demo post. When `flavor: 'slack'`, the body
 * is run through {@link markdownToSlackMrkdwn} before the footer is appended.
 */
export function formatGroupedChatReply(
  answer: string,
  sources: GroupedSource[] | undefined,
  flavor: ChatReplyFlavor = 'plain'
): string {
  let body = answer.trim()
  if (flavor === 'slack' && body) {
    body = markdownToSlackMrkdwn(body)
  }
  const footer = formatGroupedSourcesFooter(sources, flavor)
  if (!footer) return body
  if (!body) return footer
  return `${body}\n\n${footer}`
}
