import path from 'node:path'
import { scanBaseRepos } from '@kb/core/ops/auto-sync.js'
import { readOptionalCliValue, resolveBaseToDir, resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'

/**
 * `kb scan` / `/scan`: pull + re-index every git clone on the resolved base's volume and
 * rebuild the cross-repo graph. Resolves `--base`, else the active/default base. Throws if
 * the base has no indexed repos. Returns a one-line summary.
 */
export async function runScanCommand(
  args: string[],
  onProgress?: (line: string) => void
): Promise<string> {
  const baseArg = readOptionalCliValue(args, '--base')
  const baseDir = baseArg ? resolveBaseToDir(baseArg) : (await resolveEffectiveBaseDir()).baseDir
  const count = await scanBaseRepos(baseDir, { onProgress })
  if (count === 0) {
    throw new Error(
      'This base has no indexed repos to scan. Declare repos via KB_SERVER_BASE_GIT_REPOS ' +
        '(or KB_GIT_REPOS) and restart to build the index.'
    )
  }
  return `Scanned ${count} repo(s) for base "${path.basename(baseDir)}".`
}
