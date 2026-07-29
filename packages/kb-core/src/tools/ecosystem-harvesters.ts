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
  loadPackageEcosystemConfig,
  loadTypescriptEcosystemConfig,
  type KindRule,
  type PackageEcosystemConfig,
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

export interface KindSignals {
  deps: string[]
  hasBin?: boolean
  withoutBin?: boolean
  hasEntry?: boolean
  hasScriptsEntry?: boolean
  hasBinTarget?: boolean
  hasLibTarget?: boolean
  composerType?: string
  anyScript?: string[]
}

function dependencyHitsGroup(deps: string[], group: string[] | undefined): boolean {
  if (!group?.length) return false
  return group.some(name => deps.some(d => d === name || d.startsWith(`${name}/`) || d.endsWith(`/${name}`)))
}

function ruleMatchesSignals(rule: KindRule, signals: KindSignals, config: PackageEcosystemConfig): boolean {
  const match = rule.match
  const keys = Object.keys(match)
  // Fallback rule: empty match always wins when reached.
  if (keys.length === 0) return true

  let sawKnown = false
  if (match.any_dependency_group !== undefined) {
    sawKnown = true
    const group = config.frameworks[match.any_dependency_group]
    if (!dependencyHitsGroup(signals.deps, group)) return false
  }
  if (match.any_dependency !== undefined) {
    sawKnown = true
    if (!match.any_dependency.some(name => dependencyHitsGroup(signals.deps, [name]))) return false
  }
  if (match.without_dependency_group !== undefined) {
    sawKnown = true
    const group = config.frameworks[match.without_dependency_group]
    if (dependencyHitsGroup(signals.deps, group)) return false
  }
  if (match.any_script !== undefined) {
    sawKnown = true
    if (!match.any_script.some(s => signals.anyScript?.includes(s))) return false
  }
  if (match.has_bin !== undefined) {
    sawKnown = true
    if (match.has_bin !== Boolean(signals.hasBin)) return false
  }
  if (match.without_bin !== undefined) {
    sawKnown = true
    if (match.without_bin && signals.hasBin) return false
  }
  if (match.has_entry !== undefined) {
    sawKnown = true
    if (match.has_entry !== Boolean(signals.hasEntry)) return false
  }
  if (match.has_scripts_entry !== undefined) {
    sawKnown = true
    if (match.has_scripts_entry !== Boolean(signals.hasScriptsEntry)) return false
  }
  if (match.has_bin_target !== undefined) {
    sawKnown = true
    if (match.has_bin_target !== Boolean(signals.hasBinTarget)) return false
  }
  if (match.has_lib_target !== undefined) {
    sawKnown = true
    if (match.has_lib_target !== Boolean(signals.hasLibTarget)) return false
  }
  if (match.without_bin_target !== undefined) {
    sawKnown = true
    if (match.without_bin_target && signals.hasBinTarget) return false
  }
  if (match.composer_type !== undefined) {
    sawKnown = true
    if (signals.composerType !== match.composer_type) return false
  }
  // Unknown-only match keys must not spuriously match (agents may draft ahead of inference).
  return sawKnown
}

/** Apply YAML kind_rules against extracted dependency/target signals. */
export function classifyFromSignals(
  signals: KindSignals,
  config: PackageEcosystemConfig
): { kind: EntityKind; confidence: number } {
  for (const rule of config.kind_rules) {
    if (ruleMatchesSignals(rule, signals, config)) {
      return { kind: rule.kind, confidence: rule.confidence }
    }
  }
  return { kind: 'library', confidence: 0.4 }
}

/**
 * Deterministic kind rubric over package.json features — decision table from
 * `ecosystems/typescript.yaml`, not an LLM. Ambiguity lowers confidence.
 */
export function classifyPackageKind(
  pkg: PackageJson,
  config: TypescriptEcosystemConfig = loadTypescriptEcosystemConfig()
): { kind: EntityKind; confidence: number } {
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
  const hasBin = Boolean(pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0))
  return classifyFromSignals(
    {
      deps,
      hasBin,
      hasEntry: Boolean(pkg.main || pkg.exports),
      anyScript: Object.keys(pkg.scripts ?? {}),
    },
    config
  )
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
    harvestGoEcosystem(scanDir),
    harvestPythonEcosystem(scanDir),
    harvestRustEcosystem(scanDir),
    harvestPhpEcosystem(scanDir),
    harvestInfraManifests(scanDir),
  ])
  return {
    candidates: results.flatMap(r => r.candidates),
    edges: results.flatMap(r => r.edges),
  }
}

/** Parse `module path` + require deps from go.mod (best-effort). */
function parseGoMod(raw: string): { module: string | null; deps: string[] } {
  const moduleMatch = raw.match(/^module\s+(\S+)/m)
  const deps: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed === ')' || trimmed.startsWith('module ')) continue
    if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
      const parts = trimmed.slice('require '.length).split(/\s+/)
      if (parts[0]) deps.push(parts[0])
      continue
    }
    // Inside require ( ) block: "path v1.2.3"
    const req = trimmed.match(/^([^\s]+)\s+v[\d.]+/)
    if (req?.[1] && !req[1].startsWith('require')) deps.push(req[1])
  }
  return { module: moduleMatch?.[1] ?? null, deps }
}

export async function harvestGoEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('go')
  const raw = await readText(path.join(scanDir, 'go.mod'))
  if (!raw) return { candidates: [], edges: [] }
  const { module, deps } = parseGoMod(raw)
  if (!module) return { candidates: [], edges: [] }
  const { kind, confidence } = classifyFromSignals({ deps }, config)
  const short = module.includes('/') ? (module.split('/').pop() ?? module) : module
  return {
    candidates: [
      {
        kind,
        canonicalName: module,
        aliases: [module, short],
        sourceFile: 'go.mod',
        sourceKind: 'manifest',
        confidence,
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

/** Minimal TOML: extract string keys under [section] and dependency table keys. */
function tomlSectionStrings(raw: string, section: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = new RegExp(`^\\[${section.replace('.', '\\.')}\\]\\s*$`, 'm')
  const start = raw.search(re)
  if (start < 0) return out
  const rest = raw.slice(start).split('\n').slice(1)
  for (const line of rest) {
    if (/^\s*\[/.test(line)) break
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"(.*?)"/)
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2]
  }
  return out
}

function tomlTableKeys(raw: string, section: string): string[] {
  const keys: string[] = []
  const re = new RegExp(`^\\[${section.replace('.', '\\.')}\\]\\s*$`, 'm')
  const start = raw.search(re)
  if (start < 0) return keys
  const rest = raw.slice(start).split('\n').slice(1)
  for (const line of rest) {
    if (/^\s*\[/.test(line)) break
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
    if (m?.[1]) keys.push(m[1])
  }
  return keys
}

function tomlHasArrayTable(raw: string, name: string): boolean {
  return new RegExp(`^\\[\\[${name}\\]\\]`, 'm').test(raw)
}

function tomlHasTable(raw: string, name: string): boolean {
  return new RegExp(`^\\[${name}\\]`, 'm').test(raw)
}

export async function harvestPythonEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('python')
  const raw = await readText(path.join(scanDir, 'pyproject.toml'))
  if (!raw) return { candidates: [], edges: [] }
  const project = tomlSectionStrings(raw, 'project')
  const name = project.name
  if (!name) return { candidates: [], edges: [] }

  const deps: string[] = []
  // project.dependencies = ["fastapi>=0.100", ...]
  const depArray = raw.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/)
  if (depArray?.[1]) {
    for (const m of depArray[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) {
      if (m[1]) deps.push(m[1].toLowerCase().replace(/_/g, '-'))
    }
  }
  for (const key of [
    ...tomlTableKeys(raw, 'tool.poetry.dependencies'),
    ...tomlTableKeys(raw, 'project.optional-dependencies'),
  ]) {
    if (key !== 'python') deps.push(key.toLowerCase().replace(/_/g, '-'))
  }

  const hasScriptsEntry = /\[project\.scripts\]/.test(raw) || /\[tool\.poetry\.scripts\]/.test(raw)
  const { kind, confidence } = classifyFromSignals({ deps, hasScriptsEntry }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name],
        ...(project.description ? { gloss: project.description } : {}),
        sourceFile: 'pyproject.toml',
        sourceKind: 'manifest',
        confidence,
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

export async function harvestRustEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('rust')
  const raw = await readText(path.join(scanDir, 'Cargo.toml'))
  if (!raw) return { candidates: [], edges: [] }
  const pkg = tomlSectionStrings(raw, 'package')
  const name = pkg.name
  if (!name) return { candidates: [], edges: [] }

  const deps = [
    ...tomlTableKeys(raw, 'dependencies'),
    ...tomlTableKeys(raw, 'dev-dependencies'),
  ]
  const { kind, confidence } = classifyFromSignals(
    {
      deps,
      hasBinTarget: tomlHasArrayTable(raw, 'bin') || /\[\[bin\]\]/.test(raw),
      hasLibTarget: tomlHasTable(raw, 'lib'),
    },
    config
  )
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name],
        ...(pkg.description ? { gloss: pkg.description } : {}),
        sourceFile: 'Cargo.toml',
        sourceKind: 'manifest',
        confidence,
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

export async function harvestPhpEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('php')
  const raw = await readText(path.join(scanDir, 'composer.json'))
  if (!raw) return { candidates: [], edges: [] }
  let parsed: {
    name?: string
    description?: string
    type?: string
    bin?: string | string[]
    require?: Record<string, string>
    'require-dev'?: Record<string, string>
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { candidates: [], edges: [] }
  }
  if (!parsed.name) return { candidates: [], edges: [] }
  const deps = [
    ...Object.keys(parsed.require ?? {}),
    ...Object.keys(parsed['require-dev'] ?? {}),
  ].filter(d => d !== 'php')
  const hasBin = Boolean(
    parsed.bin && (typeof parsed.bin === 'string' || (Array.isArray(parsed.bin) && parsed.bin.length > 0))
  )
  const { kind, confidence } = classifyFromSignals(
    { deps, hasBin, composerType: parsed.type },
    config
  )
  const aliases = new Set<string>([parsed.name, parsed.name.split('/')[1] ?? parsed.name])
  return {
    candidates: [
      {
        kind,
        canonicalName: parsed.name,
        aliases: [...aliases],
        ...(parsed.description ? { gloss: parsed.description } : {}),
        sourceFile: 'composer.json',
        sourceKind: 'manifest',
        confidence,
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

function safeParsePackage(raw: string): PackageJson | null {
  try {
    return JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
}
