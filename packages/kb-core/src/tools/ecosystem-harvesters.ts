/**
 * Ecosystem harvesters — the deterministic half of the `entity-index` scan cycle
 * (NOMENCLATURE_INDEX_PLAN.md §4a). A harvester answers "what deployable things
 * does this repo declare" from manifest-class files: pure functions from a scan
 * directory to entity candidates, no LLM, no network.
 *
 * Registry shape mirrors LANG_CONFIGS in the tree-sitter indexer: one entry per
 * ecosystem, each degrading gracefully when its inputs are missing. TypeScript
 * is the first entry; the language-agnostic infra tier (compose / fly /
 * Backstage) runs for every repo regardless of ecosystem.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
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

const SERVER_FRAMEWORKS = [
  'express',
  'fastify',
  'koa',
  '@nestjs/core',
  'hapi',
  '@hapi/hapi',
  'restify',
]
const FRONTEND_FRAMEWORKS = ['react', 'next', 'vue', 'svelte', '@angular/core']
const CLI_FRAMEWORKS = ['commander', 'yargs', 'oclif', 'meow', 'ink']

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

/**
 * Deterministic kind rubric over package.json features — a decision table, not
 * an LLM. Ambiguity lowers confidence instead of guessing harder.
 */
export function classifyPackageKind(pkg: PackageJson): { kind: EntityKind; confidence: number } {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const hasDep = (names: string[]) => names.some(n => n in deps)
  const hasBin = Boolean(pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0))
  const hasStart = Boolean(pkg.scripts?.start || pkg.scripts?.serve)

  if (hasDep(SERVER_FRAMEWORKS) || (hasStart && !hasBin)) return { kind: 'service', confidence: hasDep(SERVER_FRAMEWORKS) ? 0.9 : 0.6 }
  if (hasBin) return { kind: 'cli', confidence: 0.85 }
  if (hasDep(FRONTEND_FRAMEWORKS)) return { kind: 'surface', confidence: 0.75 }
  if (hasDep(CLI_FRAMEWORKS)) return { kind: 'cli', confidence: 0.6 }
  if (pkg.main || pkg.exports) return { kind: 'library', confidence: 0.8 }
  return { kind: 'library', confidence: 0.4 }
}

async function workspacePackageDirs(scanDir: string): Promise<string[]> {
  const globs: string[] = []
  const pnpmWs = await readText(path.join(scanDir, 'pnpm-workspace.yaml'))
  if (pnpmWs) {
    try {
      const parsed = loadYaml(pnpmWs) as { packages?: string[] } | null
      if (parsed?.packages) globs.push(...parsed.packages)
    } catch {
      // Malformed workspace file — fall through to root-only.
    }
  }
  const rootPkg = (await readJson(path.join(scanDir, 'package.json'))) as PackageJson | null
  if (rootPkg?.workspaces) {
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages
    if (ws) globs.push(...ws)
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
 * identity + deterministic kind rubric.
 */
export async function harvestTypeScriptEcosystem(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const packageDirs = await workspacePackageDirs(scanDir)
  const rootPkgRaw = await readText(path.join(scanDir, 'package.json'))
  const rootPkg = rootPkgRaw ? safeParsePackage(rootPkgRaw) : null
  const rootName = rootPkg?.name

  const targets =
    packageDirs.length > 0
      ? packageDirs
      : rootPkgRaw
        ? [scanDir]
        : []

  for (const dir of targets) {
    const raw = await readText(path.join(dir, 'package.json'))
    if (!raw) continue
    const pkg = safeParsePackage(raw)
    if (!pkg?.name) continue

    const { kind, confidence } = classifyPackageKind(pkg)
    const aliases = new Set<string>([pkg.name, unscoped(pkg.name), path.basename(dir)])
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const binName of Object.keys(pkg.bin)) aliases.add(binName)
    }

    candidates.push({
      kind,
      canonicalName: pkg.name,
      aliases: [...aliases],
      ...(pkg.description ? { gloss: pkg.description } : {}),
      sourceFile: path.relative(scanDir, path.join(dir, 'package.json')) || 'package.json',
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
 * Language-agnostic infra tier: compose service keys, fly.toml app names,
 * Backstage catalog-info.yaml. Runs for every repo regardless of ecosystem.
 */
export async function harvestInfraManifests(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  for (const composeName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml']) {
    const raw = await readText(path.join(scanDir, composeName))
    if (!raw) continue
    try {
      const parsed = loadYaml(raw) as { services?: Record<string, unknown> } | null
      for (const serviceKey of Object.keys(parsed?.services ?? {})) {
        candidates.push({
          kind: 'service',
          canonicalName: serviceKey,
          aliases: [serviceKey],
          sourceFile: composeName,
          sourceKind: 'manifest',
          confidence: 0.85,
          contentHash: sha256(raw),
        })
      }
    } catch {
      // Malformed compose file — skip.
    }
    break
  }

  const flyRaw = await readText(path.join(scanDir, 'fly.toml'))
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
        contentHash: sha256(flyRaw),
      })
    }
  }

  const backstageRaw = await readText(path.join(scanDir, 'catalog-info.yaml'))
  if (backstageRaw) {
    try {
      const parsed = loadYaml(backstageRaw) as {
        kind?: string
        metadata?: { name?: string; description?: string }
        spec?: { type?: string; domain?: string; system?: string }
      } | null
      const name = parsed?.metadata?.name
      if (name) {
        const kind: EntityKind =
          parsed?.kind === 'API' ? 'api' : parsed?.kind === 'Domain' ? 'domain' : 'service'
        candidates.push({
          kind,
          canonicalName: name,
          aliases: [name],
          ...(parsed?.metadata?.description ? { gloss: parsed.metadata.description } : {}),
          sourceFile: 'catalog-info.yaml',
          sourceKind: 'manifest',
          confidence: 0.95,
          contentHash: sha256(backstageRaw),
        })
        const domain = parsed?.spec?.domain ?? parsed?.spec?.system
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
