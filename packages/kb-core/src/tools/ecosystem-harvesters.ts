/**
 * Ecosystem harvesters — the deterministic half of the `entity-index` scan cycle
 * (NOMENCLATURE_INDEX_PLAN.md §4a). A harvester answers "what deployable things
 * does this repo declare" from manifest-class files: pure functions from a scan
 * directory to entity candidates, no LLM, no network.
 *
 * Coverage (frameworks, kind rubric, compose/fly/Backstage, declared gaps for
 * symbols/routes) lives in YAML under `tools/ecosystems/` — one file per
 * ecosystem — so scope is code-reviewable without reading the inference code.
 * This module loads those configs and runs the harvest.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
import {
  loadInfraEcosystemConfig,
  loadTypescriptEcosystemConfig,
  type KindRule,
  type TypescriptEcosystemConfig,
} from './ecosystem-config.js'
import type { EntityKind } from './entity-registry.js'

export interface EntityCandidate {
  kind: EntityKind
  canonicalName: string
  aliases: string[]
  gloss?: string
  /** File the candidate was extracted from, repo-relative. */
  sourceFile: string
  sourceKind: 'manifest'
  confidence: number
  contentHash: string
}

export interface CandidateEdge {
  fromName: string
  toName: string
  edgeType: 'part_of' | 'belongs_to'
}

export interface HarvestResult {
  candidates: EntityCandidate[]
  edges: CandidateEdge[]
}

interface PackageJson {
  name?: string
  description?: string
  bin?: string | Record<string, string>
  main?: string
  exports?: unknown
  scripts?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Unscoped variant of an npm package name (`@acme/payments-service` → `payments-service`). */
function unscoped(name: string): string {
  return name.startsWith('@') ? (name.split('/')[1] ?? name) : name
}

function ruleMatches(rule: KindRule, pkg: PackageJson, config: TypescriptEcosystemConfig): boolean {
  const match = rule.match
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const hasBin = Boolean(pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0))
  const hasEntry = Boolean(pkg.main || pkg.exports)

  if (match.any_dependency_group) {
    const group = config.frameworks[match.any_dependency_group]
    if (!group?.some(n => n in deps)) return false
  }
  if (match.any_script?.length) {
    if (!match.any_script.some(s => Boolean(pkg.scripts?.[s]))) return false
  }
  if (match.has_bin === true && !hasBin) return false
  if (match.without_bin === true && hasBin) return false
  if (match.has_entry === true && !hasEntry) return false
  return true
}

/**
 * Deterministic kind rubric over package.json features — decision table from
 * `ecosystems/typescript.yaml`, not an LLM. Ambiguity lowers confidence.
 */
export function classifyPackageKind(
  pkg: PackageJson,
  config: TypescriptEcosystemConfig = loadTypescriptEcosystemConfig()
): { kind: EntityKind; confidence: number } {
  for (const rule of config.kind_rules) {
    if (ruleMatches(rule, pkg, config)) {
      return { kind: rule.kind, confidence: rule.confidence }
    }
  }
  return { kind: 'library', confidence: 0.4 }
}

async function workspacePackageDirs(
  scanDir: string,
  config: TypescriptEcosystemConfig
): Promise<string[]> {
  const globs: string[] = []

  for (const source of config.workspace.sources) {
    const raw = await readText(path.join(scanDir, source.path))
    if (!raw) continue
    if (source.packages_key) {
      try {
        const parsed = loadYaml(raw) as Record<string, unknown> | null
        const pkgs = parsed?.[source.packages_key]
        if (Array.isArray(pkgs)) globs.push(...pkgs.map(String))
      } catch {
        // Malformed workspace file — skip this source.
      }
    }
    if (source.workspaces_key) {
      const rootPkg = (await readJson(path.join(scanDir, source.path))) as PackageJson | null
      const ws = rootPkg?.workspaces
      if (ws) {
        const list = Array.isArray(ws) ? ws : ws.packages
        if (list) globs.push(...list)
      }
    }
  }

  const dirs = new Set<string>()
  for (const glob of globs) {
    // Support the common `dir/*` shape without pulling in a glob engine; exact
    // paths pass through. Negations and deeper wildcards are skipped.
    if (glob.startsWith('!')) continue
    if (glob.endsWith('/*')) {
      const parent = path.join(scanDir, glob.slice(0, -2))
      if (await isDir(parent)) {
        for (const child of await readdir(parent)) {
          const full = path.join(parent, child)
          if (await isDir(full)) dirs.add(full)
        }
      }
    } else if (!glob.includes('*')) {
      const full = path.join(scanDir, glob)
      if (await isDir(full)) dirs.add(full)
    }
  }
  return [...dirs]
}

/**
 * TypeScript/JavaScript ecosystem harvester: workspace topology → per-package
 * identity + YAML-driven kind rubric.
 */
export async function harvestTypeScriptEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadTypescriptEcosystemConfig()
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const packageDirs = await workspacePackageDirs(scanDir, config)
  const manifestName = config.package_manifest
  const rootPkgRaw = await readText(path.join(scanDir, manifestName))
  const rootPkg = rootPkgRaw ? safeParsePackage(rootPkgRaw) : null
  const rootName = rootPkg?.name

  const targets =
    packageDirs.length > 0
      ? packageDirs
      : rootPkgRaw
        ? [scanDir]
        : []

  for (const dir of targets) {
    const raw = await readText(path.join(dir, manifestName))
    if (!raw) continue
    const pkg = safeParsePackage(raw)
    if (!pkg?.name) continue

    const { kind, confidence } = classifyPackageKind(pkg, config)
    const aliases = new Set<string>([pkg.name, unscoped(pkg.name), path.basename(dir)])
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const binName of Object.keys(pkg.bin)) aliases.add(binName)
    }

    candidates.push({
      kind,
      canonicalName: pkg.name,
      aliases: [...aliases],
      ...(pkg.description ? { gloss: pkg.description } : {}),
      sourceFile: path.relative(scanDir, path.join(dir, manifestName)) || manifestName,
      sourceKind: 'manifest',
      confidence,
      contentHash: sha256(raw),
    })
    if (rootName && pkg.name !== rootName) {
      edges.push({ fromName: pkg.name, toName: rootName, edgeType: 'part_of' })
    }
  }

  return { candidates, edges }
}

/**
 * Language-agnostic infra tier from `ecosystems/infra.yaml`: compose service
 * keys, fly.toml app names, Backstage catalog-info.yaml.
 */
export async function harvestInfraManifests(scanDir: string): Promise<HarvestResult> {
  const config = loadInfraEcosystemConfig()
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  for (const composeName of config.compose.files) {
    const raw = await readText(path.join(scanDir, composeName))
    if (!raw) continue
    try {
      const parsed = loadYaml(raw) as Record<string, unknown> | null
      const services = parsed?.[config.compose.services_key] as Record<string, unknown> | undefined
      for (const serviceKey of Object.keys(services ?? {})) {
        candidates.push({
          kind: config.compose.kind,
          canonicalName: serviceKey,
          aliases: [serviceKey],
          sourceFile: composeName,
          sourceKind: 'manifest',
          confidence: config.compose.confidence,
          contentHash: sha256(raw),
        })
      }
    } catch {
      // Malformed compose file — skip.
    }
    break
  }

  const flyRaw = await readText(path.join(scanDir, config.fly.file))
  if (flyRaw) {
    const appMatch = flyRaw.match(new RegExp(config.fly.app_pattern, 'm'))
    if (appMatch?.[1]) {
      candidates.push({
        kind: config.fly.kind,
        canonicalName: appMatch[1],
        aliases: [appMatch[1]],
        sourceFile: config.fly.file,
        sourceKind: 'manifest',
        confidence: config.fly.confidence,
        contentHash: sha256(flyRaw),
      })
    }
  }

  const backstageRaw = await readText(path.join(scanDir, config.backstage.file))
  if (backstageRaw) {
    try {
      const parsed = loadYaml(backstageRaw) as {
        kind?: string
        metadata?: { name?: string; description?: string }
        spec?: Record<string, unknown>
      } | null
      const name = parsed?.metadata?.name
      if (name) {
        const mapped = parsed?.kind ? config.backstage.kind_map[parsed.kind] : undefined
        const kind = (mapped ?? config.backstage.kind_map.default) as EntityKind
        candidates.push({
          kind,
          canonicalName: name,
          aliases: [name],
          ...(parsed?.metadata?.description ? { gloss: parsed.metadata.description } : {}),
          sourceFile: config.backstage.file,
          sourceKind: 'manifest',
          confidence: config.backstage.confidence,
          contentHash: sha256(backstageRaw),
        })
        let domain: string | undefined
        for (const key of config.backstage.belongs_to_keys) {
          const value = parsed?.spec?.[key]
          if (typeof value === 'string' && value) {
            domain = value
            break
          }
        }
        if (domain) edges.push({ fromName: name, toName: domain, edgeType: 'belongs_to' })
      }
    } catch {
      // Malformed catalog file — skip.
    }
  }

  return { candidates, edges }
}

/**
 * Run every applicable harvester over a repo clone and merge results. Candidates
 * with the same normalized name from multiple sources are kept separately here —
 * the registry upsert (keyed on kind + canonical name) and the infra join
 * performed by the entity-index cycle merge them.
 */
export async function harvestRepoEntities(scanDir: string): Promise<HarvestResult> {
  const results = await Promise.all([
    harvestTypeScriptEcosystem(scanDir),
    harvestInfraManifests(scanDir),
  ])
  return {
    candidates: results.flatMap(r => r.candidates),
    edges: results.flatMap(r => r.edges),
  }
}

function safeParsePackage(raw: string): PackageJson | null {
  try {
    return JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
}
