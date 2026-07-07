/**
 * Gitignore-style ignore matching for KB scans.
 *
 * Ignore patterns let a base skip files/directories that are irrelevant to the knowledge
 * base (tests, vendored code, generated docs, …). The server takes them from the
 * `KB_SERVER_IGNORE` environment variable (see `readIgnorePatternsFromEnv`), applied on
 * the initial index build and every reindex.
 *
 * Matching follows `.gitignore` semantics closely enough to be unsurprising:
 *   - blank lines and `#` comments are skipped
 *   - a leading `!` negates (re-includes) a previously-ignored path
 *   - a trailing `/` matches directories only
 *   - a leading `/`, or any internal `/`, anchors the pattern to the repo root; a pattern
 *     with no slash matches by basename at any depth
 *   - `*` matches within a path segment, `**` across segments, `?` matches one character
 *   - ignoring a directory also ignores everything under it
 */

export interface IgnoreMatcher {
  /** Normalized source patterns (blank lines removed, de-duplicated, order preserved). */
  readonly patterns: string[]
  /**
   * True when any negation (`!`) rule is present. Walkers must not prune an ignored
   * directory's subtree when this is set, or a `!`-re-included child would never be visited.
   */
  readonly hasNegation: boolean
  /** Whether `relPath` (POSIX, repo-relative) is ignored. Pass `isDir` for directory entries. */
  ignores(relPath: string, isDir?: boolean): boolean
}

interface CompiledRule {
  negated: boolean
  dirOnly: boolean
  /** Matches the path itself. */
  exact: RegExp
  /** Matches any descendant of the path (the dir-ignores-its-contents case). */
  tree: RegExp
}

/** Split a free-text ignore entry (comma- or newline-separated) into individual patterns. */
export function parseIgnoreInput(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * Resolve the base's ignore patterns from the environment. `KB_SERVER_IGNORE` is a
 * comma- and/or newline-separated gitignore-style list; empty/unset → no patterns.
 */
export function readIgnorePatternsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseIgnoreInput(env.KB_SERVER_IGNORE ?? '')
}

/** Trim, drop blank lines, and de-duplicate while preserving order. */
export function normalizeIgnorePatterns(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g

/** Convert a gitignore glob body (no `!`, leading `/`, or trailing `/`) to a regex source. */
function globToRegExpSource(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          // `**/` matches any number of leading directories (including none).
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(REGEX_SPECIALS, '\\$&')
    }
  }
  return re
}

function compileRule(raw: string): CompiledRule | null {
  let pattern = raw.trim()
  if (!pattern || pattern.startsWith('#')) return null

  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  // Allow an escaped leading `#`/`!` to be treated literally.
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) pattern = pattern.slice(1)

  let dirOnly = false
  if (pattern.endsWith('/')) {
    dirOnly = true
    pattern = pattern.slice(0, -1)
  }

  pattern = pattern.replace(/^\.\//, '')
  if (!pattern) return null

  const anchored = pattern.includes('/')
  if (pattern.startsWith('/')) pattern = pattern.slice(1)
  if (!pattern) return null

  const body = globToRegExpSource(pattern)
  const prefix = anchored ? '^' : '^(?:.*/)?'
  return {
    negated,
    dirOnly,
    exact: new RegExp(`${prefix}${body}$`),
    tree: new RegExp(`${prefix}${body}/`),
  }
}

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

const NEVER_IGNORES: IgnoreMatcher = {
  patterns: [],
  hasNegation: false,
  ignores: () => false,
}

export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const normalized = normalizeIgnorePatterns(patterns)
  const rules = normalized
    .map(compileRule)
    .filter((rule): rule is CompiledRule => rule !== null)
  if (rules.length === 0) return { ...NEVER_IGNORES, patterns: normalized }

  const hasNegation = rules.some(rule => rule.negated)
  return {
    patterns: normalized,
    hasNegation,
    ignores(relPath: string, isDir = false): boolean {
      const p = normalizeRelPath(relPath)
      if (!p) return false
      let ignored = false
      for (const rule of rules) {
        let matched = false
        if (rule.tree.test(p)) {
          // The path is a descendant of the pattern — a dir-only rule still applies here.
          matched = true
        } else if (rule.exact.test(p)) {
          matched = rule.dirOnly ? isDir : true
        }
        if (matched) ignored = !rule.negated
      }
      return ignored
    },
  }
}
