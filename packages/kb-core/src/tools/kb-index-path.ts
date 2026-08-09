import path from 'node:path'

/** Absolute path to a base's SQLite index file. */
export function kbIndexDbPath(baseDir: string): string {
  return path.join(baseDir, '.kb-index.sqlite')
}
