import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AstFilesManifest {
  version: 1
  files: Record<string, string>
  updatedAt: string
}

export const AST_FILES_MANIFEST_FILENAME = 'ast-files-manifest.json'

function manifestPath(baseDir: string, repoSlug?: string): string {
  if (!repoSlug) return path.join(baseDir, AST_FILES_MANIFEST_FILENAME)
  const safe = repoSlug.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(baseDir, `ast-files-manifest.${safe}.json`)
}

export async function readAstFilesManifest(
  baseDir: string,
  repoSlug?: string
): Promise<AstFilesManifest> {
  const file = manifestPath(baseDir, repoSlug)
  if (!existsSync(file)) {
    return { version: 1, files: {}, updatedAt: '' }
  }
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AstFilesManifest>
    if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
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

export async function writeAstFilesManifest(
  baseDir: string,
  files: Record<string, string>,
  repoSlug?: string
): Promise<void> {
  const manifest: AstFilesManifest = {
    version: 1,
    files,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(manifestPath(baseDir, repoSlug), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

export function diffChangedAstFiles(
  current: Record<string, string>,
  manifest: AstFilesManifest
): string[] | null {
  if (Object.keys(manifest.files).length === 0) return null
  const changed: string[] = []
  for (const [filePath, contentHash] of Object.entries(current)) {
    if (manifest.files[filePath] !== contentHash) changed.push(filePath)
  }
  return changed
}

/** Paths present in the last manifest but absent from the current scan tree. */
export function diffRemovedAstFiles(
  current: Record<string, string>,
  manifest: AstFilesManifest
): string[] {
  if (Object.keys(manifest.files).length === 0) return []
  const removed: string[] = []
  for (const filePath of Object.keys(manifest.files)) {
    if (!(filePath in current)) removed.push(filePath)
  }
  return removed.sort()
}
