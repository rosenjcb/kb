/**
 * Ecosystem harvester registry.
 *
 * One entry per ecosystem, same shape as `LANG_CONFIGS` in the tree-sitter
 * indexer. `harvestRepoEntities` runs every harvester whose `detect` globs
 * match and merges the results; a repo with no recognized manifests yields
 * nothing and falls back to repo-level identity, which is today's behavior.
 */

import { anyManifestExists } from './fs-utils.js'
import { goHarvester } from './go.js'
import { infraHarvester } from './infra.js'
import { javaScriptHarvester } from './typescript.js'
import type { EcosystemHarvester, HarvestResult } from './types.js'

export const HARVESTERS: readonly EcosystemHarvester[] = [
  javaScriptHarvester,
  goHarvester,
  infraHarvester,
]

export async function harvestRepoEntities(scanDir: string): Promise<HarvestResult> {
  const applicable = await Promise.all(
    HARVESTERS.map(async harvester =>
      (await anyManifestExists(scanDir, harvester.detect)) ? harvester : null
    )
  )

  const results = await Promise.all(
    applicable
      .filter((harvester): harvester is EcosystemHarvester => harvester !== null)
      .map(async harvester => {
        try {
          return await harvester.harvest(scanDir)
        } catch {
          // One broken ecosystem must never fail the whole harvest.
          return { candidates: [], edges: [] } as HarvestResult
        }
      })
  )

  return {
    candidates: results.flatMap(r => r.candidates),
    edges: results.flatMap(r => r.edges),
  }
}

export { classifyPackageKind, harvestJavaScript, unscoped } from './typescript.js'
export { goModuleAliases, harvestGo, parseGoMod, parseGoWorkUses } from './go.js'
export { harvestInfra } from './infra.js'
export type { CandidateEdge, EcosystemHarvester, EntityCandidate, HarvestResult } from './types.js'
