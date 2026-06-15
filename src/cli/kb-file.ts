import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/**
 * The per-directory `.kb` project file.
 *
 * It is a TOML document that maps a working directory to a KB base and controls
 * what `kb init` / `kb scan` pick up:
 *
 * ```toml
 * base = "my-project"
 *
 * [ignore]
 * # gitignore-style patterns, excluded from init/scan
 * patterns = ["node_modules/", "*.log", "drafts/**"]
 * ```
 *
 * Older `.kb` files contained only the bare base name (plain text). Those are
 * still read transparently — see {@link parseKbFileContents}.
 */
export const KB_FILE_NAME = '.kb'

export interface KbFile {
  /** KB base name this directory maps to. */
  base?: string
  /** gitignore-style patterns excluded from `kb init` / `kb scan`. */
  ignore: string[]
}

export interface FoundKbFile extends KbFile {
  /** Absolute path of the `.kb` file that was found. */
  filePath: string
  /** Directory that contains the `.kb` file. */
  dir: string
}

/** Starter ignore patterns seeded into a freshly scaffolded `.kb` file. */
export const DEFAULT_KB_IGNORE_PATTERNS: readonly string[] = [
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.next/',
  'vendor/',
  '*.min.js',
  '*.lock',
  '*.log',
  'CHANGELOG.md',
]

function extractIgnorePatterns(value: unknown): string[] {
  const fromArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? input
          .filter((entry): entry is string => typeof entry === 'string')
          .map(entry => entry.trim())
          .filter(Boolean)
      : []

  // `ignore = ["a", "b"]`
  if (Array.isArray(value)) return fromArray(value)

  // `[ignore]\npatterns = ["a", "b"]`
  if (value && typeof value === 'object') {
    return fromArray((value as Record<string, unknown>).patterns)
  }

  return []
}

/**
 * Parse the raw contents of a `.kb` file.
 *
 * Tries TOML first; if the contents are not valid TOML (e.g. a legacy file that
 * holds only the bare base name) the first non-empty line is treated as the
 * base name and the ignore list is empty.
 */
export function parseKbFileContents(contents: string): KbFile {
  const trimmed = contents.trim()
  if (!trimmed) return { ignore: [] }

  try {
    const parsed = parseToml(trimmed) as Record<string, unknown>
    const base =
      typeof parsed.base === 'string' && parsed.base.trim() ? parsed.base.trim() : undefined
    return { base, ignore: extractIgnorePatterns(parsed.ignore) }
  } catch {
    // Legacy plain-text `.kb`: the whole file is just the base name.
    const base = trimmed.split('\n')[0]?.trim() || undefined
    return { base, ignore: [] }
  }
}

/** Serialize a {@link KbFile} to TOML, including a short header comment. */
export function serializeKbFile(file: KbFile): string {
  const data: Record<string, unknown> = {}
  if (file.base) data.base = file.base
  data.ignore = { patterns: dedupePatterns(file.ignore) }

  const header = [
    '# kb project file.',
    '# Maps this directory to a KB base and controls what `kb init` / `kb scan` read.',
    '# `[ignore].patterns` are gitignore-style globs excluded from indexing.',
    '',
    '',
  ].join('\n')

  return `${header}${stringifyToml(data)}\n`
}

function dedupePatterns(patterns: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern || seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}

/** Read and parse the `.kb` file directly inside `dir`, or null when absent/unreadable. */
export async function readKbFileAt(dir: string): Promise<KbFile | null> {
  try {
    const contents = await readFile(path.join(dir, KB_FILE_NAME), 'utf8')
    return parseKbFileContents(contents)
  } catch {
    return null
  }
}

/** Write a `.kb` file into `dir`. */
export async function writeKbFileAt(dir: string, file: KbFile): Promise<void> {
  await writeFile(path.join(dir, KB_FILE_NAME), serializeKbFile(file), 'utf8')
}

/** Walk from `startDir` up to the filesystem root looking for a `.kb` file. */
export async function findKbFileInfo(startDir: string): Promise<FoundKbFile | null> {
  let dir = path.resolve(startDir)
  while (true) {
    const found = await readKbFileAt(dir)
    if (found) {
      return { ...found, filePath: path.join(dir, KB_FILE_NAME), dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ─── gitignore-style matching ───────────────────────────────────────────────

interface CompiledPattern {
  negated: boolean
  re: RegExp
}

function globSegmentToRegex(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — match across directory boundaries.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        // `*` — match within a single path segment.
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += (c as string).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return re
}

function compilePattern(raw: string): CompiledPattern | null {
  let pattern = raw.trim()
  if (!pattern || pattern.startsWith('#')) return null

  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  // Trailing slash marks a directory; we match the directory and everything
  // under it, so the marker can simply be stripped.
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1)

  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  if (!pattern) return null

  // gitignore: a slash anywhere (other than a trailing one) anchors the pattern
  // to the `.kb` directory; otherwise it matches at any depth.
  const rootRelative = anchored || pattern.includes('/')
  const prefix = rootRelative ? '^' : '(?:^|.*/)'
  const body = globSegmentToRegex(pattern)
  // Match the path itself or anything nested beneath it.
  const suffix = '(?:/.*)?$'

  return { negated, re: new RegExp(prefix + body + suffix) }
}

/**
 * Build a matcher for gitignore-style `patterns`. The returned predicate takes a
 * path relative to the `.kb` directory and returns true when it should be
 * ignored. Later patterns win, so `!`-negations can re-include earlier matches.
 */
export function createIgnoreMatcher(patterns: string[]): (relativePath: string) => boolean {
  const compiled = patterns.map(compilePattern).filter((c): c is CompiledPattern => c !== null)

  if (compiled.length === 0) return () => false

  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (!normalized) return false
    let ignored = false
    for (const c of compiled) {
      if (c.re.test(normalized)) ignored = !c.negated
    }
    return ignored
  }
}
