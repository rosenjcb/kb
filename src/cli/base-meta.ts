import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface GitBaseMeta {
  gitUrl: string
  gitBranch: string
  lastSyncedSha: string
  lastSyncedAt: string
}

function metaPath(baseDir: string): string {
  return path.join(baseDir, 'meta.json')
}

export async function readBaseMeta(baseDir: string): Promise<GitBaseMeta | null> {
  try {
    const raw = await readFile(metaPath(baseDir), 'utf8')
    return JSON.parse(raw) as GitBaseMeta
  } catch {
    return null
  }
}

export async function writeBaseMeta(baseDir: string, meta: GitBaseMeta): Promise<void> {
  await writeFile(metaPath(baseDir), JSON.stringify(meta, null, 2), 'utf8')
}
