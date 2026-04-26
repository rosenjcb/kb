/**
 * Frozen "original lane" excerpts from repository files during `kb init`.
 * Autogen topic docs may be many while `maybeExpandSingleDocCorpus` only runs when
 * synthesis collapses to a single document — this module always appends per-file
 * snapshots so publish/Jekyll can populate originals alongside autogen.
 */
import { basenameTitle } from '../core/string-utils'

export const INIT_SOURCE_SNAPSHOT_MAX_FILES = 12
export const INIT_SOURCE_SNAPSHOT_MAX_CHARS = 8000

export type SnapshotProvenance = 'split-from-single' | 'collected-on-init'

function slugifyPathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  )
}

export function isInitReadmeHomePath(filePath: string): boolean {
  const safeName = filePath.replace(/\\/g, '/')
  return /^readme\.md$/i.test(safeName.split('/').pop() ?? '')
}

function normalizeSnapshotTitle(title: string): string {
  return title.trim().toLowerCase()
}

function provenanceLine(provenance: SnapshotProvenance): string {
  if (provenance === 'split-from-single') {
    return 'Repository excerpt captured during init (split from a single synthesis document).'
  }
  return 'Repository excerpt captured during init (frozen snapshot of this file in the repo).'
}

export interface FrozenSourceSnapshotDoc {
  title: string
  type: 'reference'
  tags: string[]
  content: string
  isOriginal: true
}

export function buildFrozenSourceSnapshotDoc(
  filePath: string,
  body: string,
  baseName: string,
  provenance: SnapshotProvenance
): FrozenSourceSnapshotDoc {
  const safeName = filePath.replace(/\\/g, '/')
  const humanTitle = basenameTitle(safeName)
  const clipped = body.slice(0, INIT_SOURCE_SNAPSHOT_MAX_CHARS)
  const tail =
    body.length > INIT_SOURCE_SNAPSHOT_MAX_CHARS ? '\n\n…(truncated during init split)…' : ''
  return {
    title: humanTitle,
    type: 'reference',
    tags: ['source-excerpt', slugifyPathSegment(safeName), baseName],
    content: `# ${humanTitle}\n\n${provenanceLine(provenance)}\n\n${clipped}${tail}\n`,
    isOriginal: true,
  }
}

/**
 * Appends one `isOriginal` snapshot per non-empty source file (README excluded),
 * skipping titles that already exist on any `isOriginal` doc (e.g. shards from
 * single-doc expansion).
 */
export function appendFrozenSourceSnapshots<T extends { title: string; isOriginal?: boolean }>(
  docs: T[],
  sourceFiles: Record<string, string>,
  baseName: string
): T[] {
  const seenOriginalTitles = new Set(
    docs.filter(d => d.isOriginal).map(d => normalizeSnapshotTitle(d.title))
  )
  const additions: FrozenSourceSnapshotDoc[] = []
  for (const filePath of Object.keys(sourceFiles).slice(0, INIT_SOURCE_SNAPSHOT_MAX_FILES)) {
    const body = sourceFiles[filePath]
    if (typeof body !== 'string' || !body.trim()) continue
    if (isInitReadmeHomePath(filePath)) continue
    const safeName = filePath.replace(/\\/g, '/')
    const humanTitle = basenameTitle(safeName)
    const key = normalizeSnapshotTitle(humanTitle)
    if (seenOriginalTitles.has(key)) continue
    seenOriginalTitles.add(key)
    additions.push(buildFrozenSourceSnapshotDoc(filePath, body, baseName, 'collected-on-init'))
  }
  return [...docs, ...(additions as unknown as T[])]
}
