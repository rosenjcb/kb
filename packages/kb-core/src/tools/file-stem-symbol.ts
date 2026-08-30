/**
 * Filename-stem concept names — the generalized form of the SFC component-name
 * fix. A file like `scope-inference.ts` declares `inferQueryScope`, never
 * "scope inference", so a question using that phrase has no symbol to hit.
 *
 * Only emit when no existing symbol on the file already matches the stem (or
 * its PascalCase / camelCase form). `Worker.java` that exports `Worker` is
 * skipped; kebab-case TypeScript is the common miss.
 */

import path from 'node:path'

/** Stems that name the file's role, not a concept — emitting them would crowd the index. */
const GENERIC_FILE_STEMS = new Set([
  'index',
  'main',
  'mod',
  'lib',
  'util',
  'utils',
  'helpers',
  'helper',
  'types',
  'type',
  'constants',
  'constant',
  'config',
  'common',
  'init',
  'app',
  'server',
  'client',
  'test',
  'tests',
  'spec',
  'setup',
])

/** Basename without extension, or undefined when the stem is too generic to index. */
export function fileStem(relPath: string): string | undefined {
  const ext = path.extname(relPath)
  const stem = path.basename(relPath, ext)
  if (!stem || stem.length < 3) return undefined
  if (GENERIC_FILE_STEMS.has(stem.toLowerCase())) return undefined
  return stem
}

/**
 * Names that already count as "this file's concept is indexed": the stem as
 * written, plus PascalCase and camelCase of a kebab/snake stem.
 */
export function fileStemAliases(stem: string): string[] {
  const parts = stem.split(/[-_]/).filter(Boolean)
  const pascal = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  const camel = pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : ''
  return [...new Set([stem, pascal, camel].filter(s => s.length > 0))]
}

export function stemAlreadyIndexed(stem: string, existingNames: Iterable<string>): boolean {
  const have = new Set([...existingNames].map(n => n.toLowerCase()))
  return fileStemAliases(stem).some(alias => have.has(alias.toLowerCase()))
}
