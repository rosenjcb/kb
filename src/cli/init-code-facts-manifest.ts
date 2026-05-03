/**
 * Tracks per-file content hashes for the `code-facts` init cycle so `kb init --rescan`
 * processes only changed source files. Stored as a small JSON sidecar next to
 * `.kb-index.sqlite` to keep the schema unchanged.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface CodeFactsManifest {
  version: 1
  /** Map of relative source path → sha256 hex of file contents seen at last code-facts run. */
  files: Record<string, string>
  updatedAt: string
}

export const CODE_FACTS_MANIFEST_FILENAME = 'code-facts-manifest.json'

export function manifestPath(baseDir: string): string {
  return path.join(baseDir, CODE_FACTS_MANIFEST_FILENAME)
}

export function hashFileContents(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export async function readCodeFactsManifest(baseDir: string): Promise<CodeFactsManifest> {
  const file = manifestPath(baseDir)
  if (!existsSync(file)) {
    return { version: 1, files: {}, updatedAt: '' }
  }
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<CodeFactsManifest>
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

export async function writeCodeFactsManifest(
  baseDir: string,
  files: Record<string, string>
): Promise<void> {
  const manifest: CodeFactsManifest = {
    version: 1,
    files,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(manifestPath(baseDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

/**
 * Compute the set of files whose contents have changed (or are new) versus a manifest snapshot.
 * Returns `null` when the manifest is empty (caller should treat as "first run, process all").
 */
export function diffChangedFiles(
  current: Record<string, string>,
  manifest: CodeFactsManifest
): string[] | null {
  if (Object.keys(manifest.files).length === 0) return null
  const changed: string[] = []
  for (const [filePath, contents] of Object.entries(current)) {
    const prior = manifest.files[filePath]
    const next = hashFileContents(contents)
    if (prior !== next) changed.push(filePath)
  }
  return changed
}

export function buildHashesFor(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, contents] of Object.entries(files)) {
    out[p] = hashFileContents(contents)
  }
  return out
}
