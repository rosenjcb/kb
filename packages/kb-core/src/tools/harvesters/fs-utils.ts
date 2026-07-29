/**
 * Shared filesystem + parsing helpers for ecosystem harvesters.
 *
 * Every harvester needs the same three things: find manifest files without
 * descending into vendored trees, read them tolerantly (a malformed manifest
 * must never fail a scan), and hash their contents for incremental skip.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import { load as loadYaml, loadAll as loadAllYaml } from 'js-yaml'
import { TREE_SITTER_SKIP_DIRS } from '../tree-sitter-indexer.js'

/**
 * Directories a harvester must never treat as first-party. Vendored trees are
 * the dominant false-positive source: `node_modules` and `vendor/` are full of
 * real manifests describing other people's software, and `examples/` /
 * `testdata/` describe software that was never deployed.
 */
export const HARVEST_SKIP_DIRS: readonly string[] = [
  ...TREE_SITTER_SKIP_DIRS,
  'third_party',
  'thirdparty',
  'testdata',
  'fixtures',
  '__fixtures__',
  'examples',
  'example',
  'samples',
  'sample',
  'templates',
  'dist-newstyle',
  'obj',
  'bin',
  '.gradle',
  '.terraform',
]

/** fast-glob ignore patterns derived from {@link HARVEST_SKIP_DIRS}. */
export const HARVEST_IGNORE: readonly string[] = HARVEST_SKIP_DIRS.map(dir => `**/${dir}/**`)

/** Max directory depth a harvester will search for manifests. */
export const HARVEST_MAX_DEPTH = 6

/**
 * Find manifest files by glob, excluding vendored/generated trees. Returns
 * repo-relative POSIX paths, sorted for deterministic output.
 */
export async function findManifests(
  scanDir: string,
  patterns: string[],
  opts?: { deep?: number; caseSensitive?: boolean }
): Promise<string[]> {
  try {
    const matches = await fg(patterns, {
      cwd: scanDir,
      ignore: [...HARVEST_IGNORE],
      deep: opts?.deep ?? HARVEST_MAX_DEPTH,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      caseSensitiveMatch: opts?.caseSensitive ?? true,
      suppressErrors: true,
    })
    return matches.sort()
  } catch {
    return []
  }
}

/** True when at least one file matches — the harvester `detect` pre-check. */
export async function anyManifestExists(scanDir: string, patterns: string[]): Promise<boolean> {
  const hits = await findManifests(scanDir, patterns, { deep: HARVEST_MAX_DEPTH })
  return hits.length > 0
}

export async function readTextFile(scanDir: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(scanDir, relPath), 'utf8')
  } catch {
    return null
  }
}

export function parseJsonSafe<T = Record<string, unknown>>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** JSON with comments / trailing commas (tsconfig, deno.jsonc, wrangler.jsonc). */
export function parseJsoncSafe<T = Record<string, unknown>>(raw: string): T | null {
  const stripped = raw
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (match, line, block) =>
      line || block ? '' : match
    )
    .replace(/,(\s*[}\]])/g, '$1')
  return parseJsonSafe<T>(stripped)
}

export function parseYamlSafe<T = unknown>(raw: string): T | null {
  try {
    return (loadYaml(raw) ?? null) as T | null
  } catch {
    return null
  }
}

/** Multi-document YAML (Kubernetes manifests, multi-entry Backstage catalogs). */
export function parseYamlAllSafe<T = unknown>(raw: string): T[] {
  try {
    return loadAllYaml(raw).filter((doc): doc is T => doc !== null && doc !== undefined)
  } catch {
    return []
  }
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Repo-relative POSIX path — candidates must be comparable across platforms. */
export function toRelPosix(scanDir: string, absPath: string): string {
  return path.relative(scanDir, absPath).split(path.sep).join('/')
}

/** Directory name of a manifest, used as a fallback alias across ecosystems. */
export function manifestDirName(relPath: string): string {
  const dir = path.posix.dirname(relPath)
  return dir === '.' || dir === '' ? '' : path.posix.basename(dir)
}
