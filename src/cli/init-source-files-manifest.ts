import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface SourceFilesManifest {
  version: 1
  /** Map of relative markdown/text source path → sha256 hex of file contents seen at last write cycle. */
  files: Record<string, string>
  updatedAt: string
}

export const SOURCE_FILES_MANIFEST_FILENAME = 'source-files-manifest.json'

function manifestPath(baseDir: string): string {
  return path.join(baseDir, SOURCE_FILES_MANIFEST_FILENAME)
}

export function hashSourceFileContents(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export async function readSourceFilesManifest(baseDir: string): Promise<SourceFilesManifest> {
  const file = manifestPath(baseDir)
  if (!existsSync(file)) {
    return { version: 1, files: {}, updatedAt: '' }
  }
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SourceFilesManifest>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.files ||
      typeof parsed.files !== 'object'
    ) {
      return { version: 1, files: {}, updatedAt: '' }
    }
    return {
      version: 1,
      files: parsed.files as Record<string, string>,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return { version: 1, files: {}, updatedAt: '' }
  }
}

export async function writeSourceFilesManifest(
  baseDir: string,
  files: Record<string, string>
): Promise<void> {
  const manifest: SourceFilesManifest = {
    version: 1,
    files,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(manifestPath(baseDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

/**
 * Returns changed/new source paths, or `null` when there is no prior manifest yet
 * and callers should treat the run as "process all files".
 */
export function diffChangedSourceFiles(
  current: Record<string, string>,
  manifest: SourceFilesManifest
): string[] | null {
  if (Object.keys(manifest.files).length === 0) return null
  const changed: string[] = []
  for (const [filePath, contents] of Object.entries(current)) {
    const prior = manifest.files[filePath]
    const next = hashSourceFileContents(contents)
    if (prior !== next) changed.push(filePath)
  }
  return changed
}

/** Paths present in the last manifest but absent from the current scan tree. */
export function diffRemovedSourceFiles(
  current: Record<string, string>,
  manifest: SourceFilesManifest
): string[] {
  if (Object.keys(manifest.files).length === 0) return []
  const removed: string[] = []
  for (const filePath of Object.keys(manifest.files)) {
    if (!(filePath in current)) removed.push(filePath)
  }
  return removed.sort()
}

export function buildSourceFileHashes(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [filePath, contents] of Object.entries(files)) {
    out[filePath] = hashSourceFileContents(contents)
  }
  return out
}
