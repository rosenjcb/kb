/**
 * Integration-signal ingest: read each repo's manifest + env files and emit the facts
 * that let `reconcileCrossRepoEdges` bridge repos into one graph. Runs per repo during the
 * read-inputs cycle (scanDir = that repo's clone), tagging every fact with the repo slug.
 *
 * Signals (JS ecosystem + env first; extensible to go.mod / requirements.txt / Cargo.toml):
 * - package.json `name`        → `package_name_of` (subject=pkgName, object=slug)
 * - package.json dependencies  → `depends_on`      (subject=slug, object=depName)
 * - .env / .env.example URLs   → `references_service` (subject=slug, object=host)
 * - always                     → `is_repo`         (subject=slug, object=gitUrl)
 */

import type { FactEvidenceKind } from './fact-evidence'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index.js'

export interface IntegrationIngestInput {
  baseDir: string
  scanDir: string
  /** Repo slug — provenance value and source_ref prefix. */
  gitRepo: string
  gitUrl?: string
}

export interface IntegrationIngestResult {
  packageName?: string
  dependencyFacts: number
  serviceRefFacts: number
}

/** Integration payloads are ordinary statements about their subject. */
const INTEGRATION_EVIDENCE: FactEvidenceKind = 'descriptive'

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Pull hostnames out of URL-like env values (https://auth-service.internal → auth-service.internal). */
function extractServiceHosts(value: string): string[] {
  const hosts: string[] = []
  const urlMatch = value.match(/[a-z][a-z0-9+.-]*:\/\/([^/\s:]+)/gi)
  if (urlMatch) {
    for (const m of urlMatch) {
      const host = m.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:]/)[0]
      if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host)) hosts.push(host)
    }
  }
  return hosts
}

export async function ingestIntegrationSignals(
  input: IntegrationIngestInput
): Promise<IntegrationIngestResult> {
  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  const slug = input.gitRepo
  const refPrefix = `${slug}/integration:`

  const result: IntegrationIngestResult = { dependencyFacts: 0, serviceRefFacts: 0 }

  try {
    // Clear this repo's prior integration facts so removed deps/services don't linger.
    for (const fact of indexer.listActiveFactsBySourceRefPrefix(refPrefix)) {
      indexer.tombstoneFactById(fact.id)
    }

    indexer.upsertFact({
      factText: `Repository ${slug} is tracked from ${input.gitUrl ?? slug}.`,
      triplet: { subject: slug, predicate: 'is_repo', object: input.gitUrl ?? slug },
      sourceKind: 'import_doc',
      sourceRef: `${refPrefix}repo`,
      evidence: INTEGRATION_EVIDENCE,
      gitRepo: slug,
    })

    const pkg = await readJsonFile(path.join(input.scanDir, 'package.json'))
    if (pkg) {
      const name = typeof pkg.name === 'string' ? pkg.name : undefined
      if (name) {
        result.packageName = name
        indexer.upsertFact({
          factText: `Package ${name} is provided by repository ${slug}.`,
          triplet: { subject: name, predicate: 'package_name_of', object: slug },
          sourceKind: 'import_doc',
          sourceRef: `${refPrefix}package`,
          evidence: INTEGRATION_EVIDENCE,
          gitRepo: slug,
        })
      }
      const deps = new Set<string>()
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const block = pkg[field]
        if (block && typeof block === 'object') {
          for (const dep of Object.keys(block as Record<string, unknown>)) deps.add(dep)
        }
      }
      for (const dep of deps) {
        indexer.upsertFact({
          factText: `Repository ${slug} depends on package ${dep}.`,
          triplet: { subject: slug, predicate: 'depends_on', object: dep },
          sourceKind: 'import_doc',
          sourceRef: `${refPrefix}dep:${dep}`,
          evidence: INTEGRATION_EVIDENCE,
          gitRepo: slug,
        })
        result.dependencyFacts += 1
      }
    }

    const seenHosts = new Set<string>()
    for (const envFile of ['.env', '.env.example', '.env.sample']) {
      const text = await readTextFile(path.join(input.scanDir, envFile))
      if (!text) continue
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        for (const host of extractServiceHosts(value)) {
          if (seenHosts.has(host)) continue
          seenHosts.add(host)
          indexer.upsertFact({
            factText: `Repository ${slug} references service ${host}.`,
            triplet: { subject: slug, predicate: 'references_service', object: host },
            sourceKind: 'import_doc',
            sourceRef: `${refPrefix}env:${host}`,
            evidence: INTEGRATION_EVIDENCE,
            gitRepo: slug,
          })
          result.serviceRefFacts += 1
        }
      }
    }
  } finally {
    indexer.close()
  }

  return result
}
