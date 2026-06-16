import path from 'node:path'
import { scanBaseRepos } from './auto-sync'
import { readBaseMeta } from './base-meta'
import { readOptionalCliValue, resolveBaseToDir, resolveEffectiveBaseDir } from './base-selection'

/**
 * `kb scan` / `/scan`: pull + re-index every git repo the resolved base tracks and rebuild
 * the cross-repo graph. Resolves `--base`, else the active/default base. Throws if the base
 * tracks no repos. Returns a one-line summary.
 */
export async function runScanCommand(
  args: string[],
  onProgress?: (line: string) => void
): Promise<string> {
  const baseArg = readOptionalCliValue(args, '--base')
  const baseDir = baseArg ? resolveBaseToDir(baseArg) : (await resolveEffectiveBaseDir()).baseDir
  const meta = await readBaseMeta(baseDir)
  if (!meta || meta.repos.length === 0) {
    throw new Error(
      'This base has no git repos to scan. Add one with `kb base repo add <url>` or create a base with `kb init --git <url>`.'
    )
  }
  await scanBaseRepos(baseDir, { onProgress })
  return `Scanned ${meta.repos.length} repo(s) for base "${path.basename(baseDir)}".`
}
