/**
 * Language-agnostic infrastructure harvester.
 *
 * The highest-value tier: ops artifacts converged on a handful of formats even
 * though language ecosystems never did, so a k8s Deployment or a compose
 * service key names a deployable the same way whether the code inside is Go,
 * Rails, or a Python worker with no HTTP surface at all.
 */

import {
  findManifests,
  hashContent,
  parseYamlSafe,
  readTextFile,
} from './fs-utils.js'
import type { CandidateEdge, EcosystemHarvester, EntityCandidate, HarvestResult } from './types.js'
import type { EntityKind } from '../entity-registry.js'

const ECOSYSTEM = 'infra'

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']

export async function harvestInfra(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  // --- docker compose: service keys ---------------------------------------
  for (const composeName of COMPOSE_FILES) {
    const raw = await readTextFile(scanDir, composeName)
    if (!raw) continue
    const parsed = parseYamlSafe<{ services?: Record<string, unknown> }>(raw)
    for (const serviceKey of Object.keys(parsed?.services ?? {})) {
      candidates.push({
        kind: 'service',
        canonicalName: serviceKey,
        aliases: [serviceKey],
        sourceFile: composeName,
        sourceKind: 'manifest',
        confidence: 0.85,
        contentHash: hashContent(raw),
        ecosystem: ECOSYSTEM,
      })
    }
    break
  }

  // --- fly.toml: app name --------------------------------------------------
  const flyRaw = await readTextFile(scanDir, 'fly.toml')
  if (flyRaw) {
    const appMatch = flyRaw.match(/^app\s*=\s*["']([^"']+)["']/m)
    if (appMatch?.[1]) {
      candidates.push({
        kind: 'service',
        canonicalName: appMatch[1],
        aliases: [appMatch[1]],
        sourceFile: 'fly.toml',
        sourceKind: 'manifest',
        confidence: 0.85,
        contentHash: hashContent(flyRaw),
        ecosystem: ECOSYSTEM,
      })
    }
  }

  // --- Backstage catalog ---------------------------------------------------
  for (const relPath of await findManifests(scanDir, ['catalog-info.yaml', '**/catalog-info.yaml'])) {
    const raw = await readTextFile(scanDir, relPath)
    if (!raw) continue
    const parsed = parseYamlSafe<{
      kind?: string
      metadata?: { name?: string; description?: string }
      spec?: { type?: string; domain?: string; system?: string }
    }>(raw)
    const name = parsed?.metadata?.name
    if (!name) continue
    const kind: EntityKind =
      parsed?.kind === 'API' ? 'api' : parsed?.kind === 'Domain' ? 'domain' : 'service'
    candidates.push({
      kind,
      canonicalName: name,
      aliases: [name],
      ...(parsed?.metadata?.description ? { gloss: parsed.metadata.description } : {}),
      sourceFile: relPath,
      sourceKind: 'manifest',
      confidence: 0.95,
      contentHash: hashContent(raw),
      ecosystem: ECOSYSTEM,
    })
    const domain = parsed?.spec?.domain ?? parsed?.spec?.system
    if (domain) edges.push({ fromName: name, toName: domain, edgeType: 'belongs_to' })
  }

  return { candidates, edges }
}

export const infraHarvester: EcosystemHarvester = {
  id: ECOSYSTEM,
  detect: [...COMPOSE_FILES, 'fly.toml', '**/catalog-info.yaml'],
  harvest: harvestInfra,
}
