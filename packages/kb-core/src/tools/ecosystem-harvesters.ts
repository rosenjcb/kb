/**
 * Ecosystem harvesters — the deterministic half of the `entity-index` scan cycle
 * (packages/kb-core/src/tools/ECOSYSTEM_HARVESTERS.spec.md §4a). A harvester answers "what deployable things
 * does this repo declare" from manifest-class files: pure functions from a scan
 * directory to entity candidates, no LLM, no network.
 *
 * Coverage (frameworks, kind rubric, compose/fly/Backstage/k8s/Helm/Procfile,
 * OpenAPI/protobuf contracts, tier-4 `source_patterns`, declared gaps) lives in
 * YAML under `tools/ecosystems/` — one file per ecosystem plus `common.yaml`.
 * Package kind harvest runs here; tier-4 routes/modules/models run through
 * `pattern-engine.ts` against YAML `source_patterns`.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
import {
  type KindRule,
  type PackageEcosystemConfig,
  type TypescriptEcosystemConfig,
  loadInfraEcosystemConfig,
  loadPackageEcosystemConfig,
  loadTypescriptEcosystemConfig,
} from './ecosystem-config.js'
import type { EntityKind } from './entity-registry.js'
import {
  type NextRouteHit,
  type PrismaSchemaAtom,
  expandRailsResourceRoutes,
  isPlausibleHttpRoute,
  isPlausibleModelName,
  isPlausibleTypeName,
  joinHttpPaths,
  nextRouteFromFile,
  prismaSchemaAtoms,
  railsNestedRoutes,
  rawNodeHttpRoutes,
  runOpenApiPathItems,
  runSourcePatterns,
} from './pattern-engine.js'

export {
  expandRailsResourceRoutes,
  isPlausibleHttpRoute,
  isPlausibleModelName,
  isPlausibleTypeName,
  joinHttpPaths,
  nextRouteFromFile,
  prismaSchemaAtoms,
  railsNestedRoutes,
  rawNodeHttpRoutes,
  type NextRouteHit,
  type PrismaSchemaAtom,
}

export interface EntityCandidate {
  kind: EntityKind
  canonicalName: string
  aliases: string[]
  gloss?: string
  /** File the candidate was extracted from, repo-relative. */
  sourceFile: string
  sourceKind: 'manifest'
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
  /** Unscoped package / module name for name_ends_with rules. */
  packageName?: string
  /** Bin command names (object keys or basename of string bin). */
  binNames?: string[]
  hasBin?: boolean
  withoutBin?: boolean
  hasEntry?: boolean
  hasScriptsEntry?: boolean
  hasBinTarget?: boolean
  hasLibTarget?: boolean
  composerType?: string
  anyScript?: string[]
  /** MSBuild OutputType (Exe / Library / WinExe). */
  outputType?: string
  /** Project Sdk attribute values (e.g. Microsoft.NET.Sdk.Web). */
  sdks?: string[]
  hasExecutableStanza?: boolean
  hasLibraryStanza?: boolean
}

function dependencyHitsGroup(deps: string[], group: string[] | undefined): boolean {
  if (!group?.length) return false
  return group.some(name =>
    deps.some(d => d === name || d.startsWith(`${name}/`) || d.endsWith(`/${name}`))
  )
}

function ruleMatchesSignals(
  rule: KindRule,
  signals: KindSignals,
  config: PackageEcosystemConfig
): boolean {
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
  if (match.name_ends_with !== undefined) {
    sawKnown = true
    const raw = signals.packageName ?? ''
    const leaf = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw
    const suffix = match.name_ends_with.startsWith('-')
      ? match.name_ends_with.slice(1)
      : match.name_ends_with
    if (leaf !== suffix && !leaf.endsWith(match.name_ends_with) && !leaf.endsWith(suffix)) {
      return false
    }
  }
  if (match.bin_name_ends_with !== undefined) {
    sawKnown = true
    const suffix = match.bin_name_ends_with
    const names = signals.binNames ?? []
    const bare = suffix.startsWith('-') ? suffix.slice(1) : suffix
    if (!names.some(b => b === bare || b.endsWith(suffix) || b.endsWith(bare))) return false
  }
  if (match.output_type !== undefined) {
    sawKnown = true
    if (signals.outputType !== match.output_type) return false
  }
  if (match.any_sdk !== undefined) {
    sawKnown = true
    const sdks = signals.sdks ?? []
    if (!match.any_sdk.some(s => sdks.includes(s))) return false
  }
  if (match.has_executable_stanza !== undefined) {
    sawKnown = true
    if (match.has_executable_stanza !== Boolean(signals.hasExecutableStanza)) return false
  }
  if (match.has_library_stanza !== undefined) {
    sawKnown = true
    if (match.has_library_stanza !== Boolean(signals.hasLibraryStanza)) return false
  }
  // Unknown-only match keys must not spuriously match (agents may draft ahead of inference).
  return sawKnown
}

/**
 * Apply YAML kind_rules against extracted dependency/target signals. First match
 * wins; `library` is the fallback when nothing matched. Rules carry no weights —
 * a rule either describes this package or it doesn't.
 */
export function classifyFromSignals(
  signals: KindSignals,
  config: PackageEcosystemConfig
): EntityKind {
  for (const rule of config.kind_rules) {
    if (ruleMatchesSignals(rule, signals, config)) return rule.kind
  }
  return 'library'
}

/**
 * Deterministic kind rubric over package.json features — decision table from
 * `ecosystems/typescript.yaml`, not an LLM.
 */
function packageBinNames(bin: PackageJson['bin']): string[] {
  if (!bin) return []
  if (typeof bin === 'string') return [path.basename(bin)]
  return Object.keys(bin)
}

export function classifyPackageKind(
  pkg: PackageJson,
  config: TypescriptEcosystemConfig = loadTypescriptEcosystemConfig()
): EntityKind {
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
  const binNames = packageBinNames(pkg.bin)
  const hasBin = binNames.length > 0 || Boolean(pkg.bin && typeof pkg.bin === 'string')
  return classifyFromSignals(
    {
      deps,
      packageName: typeof pkg.name === 'string' ? pkg.name : undefined,
      binNames,
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

  const targets = packageDirs.length > 0 ? packageDirs : rootPkgRaw ? [scanDir] : []

  for (const dir of targets) {
    const raw = await readText(path.join(dir, manifestName))
    if (!raw) continue
    const pkg = safeParsePackage(raw)
    if (!pkg?.name) continue

    const kind = classifyPackageKind(pkg, config)
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
 * keys, fly.toml app names, Backstage catalog-info.yaml, Kubernetes/Helm/
 * Procfile.
 */
export async function harvestInfraManifests(scanDir: string): Promise<HarvestResult> {
  const config = loadInfraEcosystemConfig()
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []
  const seen = new Set<string>()

  const pushCandidate = (c: EntityCandidate): void => {
    const key = `${c.kind}\0${c.canonicalName}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }

  for (const composeName of config.compose.files) {
    const raw = await readText(path.join(scanDir, composeName))
    if (!raw) continue
    try {
      const parsed = loadYaml(raw) as Record<string, unknown> | null
      const services = parsed?.[config.compose.services_key] as Record<string, unknown> | undefined
      for (const serviceKey of Object.keys(services ?? {})) {
        pushCandidate({
          kind: config.compose.kind,
          canonicalName: serviceKey,
          aliases: [serviceKey],
          sourceFile: composeName,
          sourceKind: 'manifest',
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
      pushCandidate({
        kind: config.fly.kind,
        canonicalName: appMatch[1],
        aliases: [appMatch[1]],
        sourceFile: config.fly.file,
        sourceKind: 'manifest',
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
        pushCandidate({
          kind,
          canonicalName: name,
          aliases: [name],
          ...(parsed?.metadata?.description ? { gloss: parsed.metadata.description } : {}),
          sourceFile: config.backstage.file,
          sourceKind: 'manifest',
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

  await harvestKubernetesManifests(scanDir, config, pushCandidate)
  await harvestHelmCharts(scanDir, config, pushCandidate)
  await harvestProcfile(scanDir, config, pushCandidate)

  return { candidates, edges }
}

const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'target',
  'vendor',
  '.kb',
  'coverage',
  'build',
  '__pycache__',
  '.next',
  '.turbo',
])

/** Deterministic depth-first walk; skips common build/vendor dirs. */
async function walkFiles(
  root: string,
  opts: { extensions?: Set<string>; basenames?: Set<string>; maxFiles?: number } = {}
): Promise<string[]> {
  const out: string[] = []
  const maxFiles = opts.maxFiles ?? 2000
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()
    if (!dir) break
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    entries.sort()
    for (const name of entries) {
      if (out.length >= maxFiles) break
      if (WALK_SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!st.isFile()) continue
      if (opts.basenames && !opts.basenames.has(name)) continue
      if (opts.extensions) {
        const ext = path.extname(name).toLowerCase()
        if (!opts.extensions.has(ext)) continue
      }
      out.push(full)
    }
  }
  return out
}

function splitYamlDocuments(raw: string): string[] {
  return raw
    .split(/^---\s*$/m)
    .map(d => d.trim())
    .filter(Boolean)
}

async function harvestKubernetesManifests(
  scanDir: string,
  config: ReturnType<typeof loadInfraEcosystemConfig>,
  pushCandidate: (c: EntityCandidate) => void
): Promise<void> {
  const kindSet = new Set(config.kubernetes.kinds)
  const yamlExt = new Set(['.yaml', '.yml'])
  const files = new Set<string>()

  for (const dir of config.kubernetes.dirs) {
    const full = path.join(scanDir, dir)
    if (!(await isDir(full))) continue
    for (const f of await walkFiles(full, { extensions: yamlExt, maxFiles: 500 })) {
      files.add(f)
    }
  }
  for (const f of await walkFiles(scanDir, { extensions: yamlExt, maxFiles: 800 })) {
    files.add(f)
  }

  const marker = config.kubernetes.skip_template_marker
  for (const filePath of [...files].sort()) {
    const raw = await readText(filePath)
    if (!raw) continue
    if (marker && raw.includes(marker)) continue
    const rel = path.relative(scanDir, filePath)
    for (const doc of splitYamlDocuments(raw)) {
      if (!/\bkind\s*:/i.test(doc)) continue
      try {
        const parsed = loadYaml(doc) as {
          kind?: string
          metadata?: { name?: string }
        } | null
        const k8sKind = parsed?.kind
        const name = parsed?.metadata?.name
        if (!k8sKind || !name || !kindSet.has(k8sKind)) continue
        const mapped = config.kubernetes.kind_map[k8sKind]
        const kind = (mapped ?? config.kubernetes.kind_map.default) as EntityKind
        pushCandidate({
          kind,
          canonicalName: name,
          aliases: [name],
          sourceFile: rel,
          sourceKind: 'manifest',
          contentHash: sha256(doc),
        })
      } catch {
        // Malformed doc — skip.
      }
    }
  }
}

async function harvestHelmCharts(
  scanDir: string,
  config: ReturnType<typeof loadInfraEcosystemConfig>,
  pushCandidate: (c: EntityCandidate) => void
): Promise<void> {
  const chartName = config.helm.file
  const files = await walkFiles(scanDir, {
    basenames: new Set([chartName]),
    maxFiles: 100,
  })
  for (const filePath of files.sort()) {
    const raw = await readText(filePath)
    if (!raw) continue
    if (raw.includes('{{')) continue
    try {
      const parsed = loadYaml(raw) as Record<string, unknown> | null
      const name = parsed?.[config.helm.name_key]
      if (typeof name !== 'string' || !name) continue
      pushCandidate({
        kind: config.helm.kind,
        canonicalName: name,
        aliases: [name],
        sourceFile: path.relative(scanDir, filePath),
        sourceKind: 'manifest',
        contentHash: sha256(raw),
      })
    } catch {
      // Malformed Chart.yaml — skip.
    }
  }
}

async function harvestProcfile(
  scanDir: string,
  config: ReturnType<typeof loadInfraEcosystemConfig>,
  pushCandidate: (c: EntityCandidate) => void
): Promise<void> {
  const raw = await readText(path.join(scanDir, config.procfile.file))
  if (!raw) return
  const processTypes: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:/)
    if (m?.[1]) processTypes.push(m[1])
  }
  if (processTypes.length === 0) return
  const basename = path.basename(scanDir)
  pushCandidate({
    kind: config.procfile.kind,
    canonicalName: basename,
    aliases: [...new Set([basename, ...processTypes])],
    sourceFile: config.procfile.file,
    sourceKind: 'manifest',
    contentHash: sha256(raw),
  })
}


/**
 * Tier-3 interface contracts: OpenAPI/Swagger titles and protobuf `service`
 * blocks → `api` kind candidates.
 */
export async function harvestContractManifests(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const seen = new Set<string>()
  const push = (c: EntityCandidate): void => {
    const key = `${c.kind}\0${c.canonicalName}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }

  const yamlExt = new Set(['.yaml', '.yml', '.json'])
  const files = await walkFiles(scanDir, { extensions: yamlExt, maxFiles: 500 })
  const openapiBasenames = new Set([
    'openapi.yaml',
    'openapi.yml',
    'openapi.json',
    'swagger.yaml',
    'swagger.yml',
    'swagger.json',
  ])

  for (const filePath of files.sort()) {
    const base = path.basename(filePath).toLowerCase()
    const raw = await readText(filePath)
    if (!raw) continue
    const looksOpenApi =
      openapiBasenames.has(base) || /^\s*openapi\s*:/m.test(raw) || /^\s*swagger\s*:/m.test(raw)
    if (!looksOpenApi) continue
    type OpenApiDoc = {
      info?: { title?: string }
      openapi?: string
      swagger?: string
      paths?: Record<string, Record<string, unknown> | undefined>
    }
    let parsed: OpenApiDoc | null = null
    try {
      if (base.endsWith('.json')) {
        parsed = JSON.parse(raw) as OpenApiDoc
        if (!parsed.openapi && !parsed.swagger && !openapiBasenames.has(base)) continue
      } else {
        parsed = loadYaml(raw) as OpenApiDoc | null
        if (!parsed?.openapi && !parsed?.swagger && !openapiBasenames.has(base)) continue
      }
    } catch {
      continue
    }
    const rel = path.relative(scanDir, filePath)
    const hash = sha256(raw)
    const title = parsed?.info?.title
    if (title && typeof title === 'string') {
      push({
        kind: 'api',
        canonicalName: title,
        aliases: [title],
        gloss: 'OpenAPI info.title',
        sourceFile: rel,
        sourceKind: 'manifest',
        contentHash: hash,
      })
    }
    for (const c of runOpenApiPathItems(parsed ?? {}, rel, hash)) {
      push(c)
    }
  }

  const protoFiles = await walkFiles(scanDir, { extensions: new Set(['.proto']), maxFiles: 300 })
  for (const filePath of protoFiles.sort()) {
    const raw = await readText(filePath)
    if (!raw) continue
    const pkgMatch = raw.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m)
    const pkg = pkgMatch?.[1]
    for (const m of raw.matchAll(/^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)) {
      const svc = m[1]
      if (!svc) continue
      const canonical = pkg ? `${pkg}.${svc}` : svc
      push({
        kind: 'api',
        canonicalName: canonical,
        aliases: pkg ? [canonical, svc] : [svc],
        sourceFile: path.relative(scanDir, filePath),
        sourceKind: 'manifest',
        contentHash: sha256(raw),
      })
    }
  }

  return { candidates, edges: [] }
}

export async function harvestRouteDecorators(scanDir: string): Promise<HarvestResult> {
  return runSourcePatterns(scanDir, { phase: 'routes' })
}

/**
 * Tier-4 app-layer harvest: service/controller/handler classes → `module`,
 * ORM models / tables → `model`. YAML `source_patterns` drive extraction.
 * Deliberately does **not** use kind `service` (reserved for deployables).
 */
export async function harvestAppConcepts(scanDir: string): Promise<HarvestResult> {
  return runSourcePatterns(scanDir, { phase: 'app' })
}

export async function harvestRepoEntities(scanDir: string): Promise<HarvestResult> {
  const results = await Promise.all([
    harvestTypeScriptEcosystem(scanDir),
    harvestGoEcosystem(scanDir),
    harvestPythonEcosystem(scanDir),
    harvestRustEcosystem(scanDir),
    harvestPhpEcosystem(scanDir),
    harvestRubyEcosystem(scanDir),
    harvestJavaEcosystem(scanDir),
    harvestHaskellEcosystem(scanDir),
    harvestCppEcosystem(scanDir),
    harvestCsharpEcosystem(scanDir),
    harvestScalaEcosystem(scanDir),
    harvestInfraManifests(scanDir),
    harvestContractManifests(scanDir),
    harvestRouteDecorators(scanDir),
    harvestAppConcepts(scanDir),
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
    if (!trimmed || trimmed.startsWith('//') || trimmed === ')' || trimmed.startsWith('module '))
      continue
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
  const kind = classifyFromSignals({ deps }, config)
  const short = module.includes('/') ? (module.split('/').pop() ?? module) : module
  return {
    candidates: [
      {
        kind,
        canonicalName: module,
        aliases: [module, short],
        sourceFile: 'go.mod',
        sourceKind: 'manifest',
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
  const kind = classifyFromSignals({ deps, hasScriptsEntry }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name],
        ...(project.description ? { gloss: project.description } : {}),
        sourceFile: 'pyproject.toml',
        sourceKind: 'manifest',
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

  const deps = [...tomlTableKeys(raw, 'dependencies'), ...tomlTableKeys(raw, 'dev-dependencies')]
  const kind = classifyFromSignals(
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
    parsed.bin &&
      (typeof parsed.bin === 'string' || (Array.isArray(parsed.bin) && parsed.bin.length > 0))
  )
  const kind = classifyFromSignals(
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
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

async function listFilesWithExt(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter(e => e.endsWith(ext)).map(e => path.join(dir, e))
  } catch {
    return []
  }
}

function parseGemfileDeps(raw: string): string[] {
  const deps: string[] = []
  for (const m of raw.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) deps.push(m[1])
  }
  return deps
}

function parseGemspec(raw: string): {
  name: string | null
  summary: string | null
  description: string | null
  deps: string[]
  executables: string[]
} {
  const name =
    raw.match(/\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
    raw.match(/spec\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
    null
  const summary = raw.match(/\.summary\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null
  const description = raw.match(/\.description\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null
  const deps: string[] = []
  for (const m of raw.matchAll(
    /(?:add_(?:runtime_)?dependency|add_development_dependency)\s*\(?\s*['"]([^'"]+)['"]/g
  )) {
    if (m[1]) deps.push(m[1])
  }
  const executables: string[] = []
  const execBlock = raw.match(/\.executables\s*=\s*\[([^\]]*)\]/)
  if (execBlock?.[1]) {
    for (const m of execBlock[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (m[1]) executables.push(m[1])
    }
  }
  return { name, summary, description, deps, executables }
}

export async function harvestRubyEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('ruby')
  const candidates: EntityCandidate[] = []
  const gemspecs = await listFilesWithExt(scanDir, '.gemspec')
  const gemfileRaw = await readText(path.join(scanDir, 'Gemfile'))
  const gemfileDeps = gemfileRaw ? parseGemfileDeps(gemfileRaw) : []

  for (const gemspecPath of gemspecs) {
    const raw = await readText(gemspecPath)
    if (!raw) continue
    const parsed = parseGemspec(raw)
    if (!parsed.name) continue
    const deps = [...parsed.deps, ...gemfileDeps]
    const kind = classifyFromSignals(
      { deps, hasBin: parsed.executables.length > 0, binNames: parsed.executables },
      config
    )
    const aliases = new Set<string>([
      parsed.name,
      parsed.name.replace(/_/g, '-'),
      parsed.name.replace(/-/g, '_'),
      path.basename(scanDir),
      ...parsed.executables,
    ])
    candidates.push({
      kind,
      canonicalName: parsed.name,
      aliases: [...aliases],
      ...(parsed.summary || parsed.description
        ? { gloss: parsed.summary ?? parsed.description ?? undefined }
        : {}),
      sourceFile: path.basename(gemspecPath),
      sourceKind: 'manifest',
      contentHash: sha256(raw),
    })
  }

  // Gemfile-only app root (typical Rails) when no gemspec provides identity.
  if (candidates.length === 0 && gemfileRaw) {
    const name = path.basename(scanDir)
    const kind = classifyFromSignals({ deps: gemfileDeps }, config)
    candidates.push({
      kind,
      canonicalName: name,
      aliases: [name],
      sourceFile: 'Gemfile',
      sourceKind: 'manifest',
      contentHash: sha256(gemfileRaw),
    })
  }

  return { candidates, edges: [] }
}

function xmlTag(raw: string, tag: string): string | null {
  return raw.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]?.trim() ?? null
}

function xmlTags(raw: string, tag: string): string[] {
  return [...raw.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))]
    .map(m => m[1]?.trim())
    .filter((v): v is string => Boolean(v))
}

function parseMavenDeps(raw: string): string[] {
  const deps: string[] = []
  for (const m of raw.matchAll(
    /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g
  )) {
    if (m[1] && m[2]) {
      deps.push(m[1].trim(), m[2].trim(), `${m[1].trim()}:${m[2].trim()}`)
    }
  }
  // Plugins (spring-boot-maven-plugin etc.)
  for (const m of raw.matchAll(
    /<plugin>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g
  )) {
    if (m[1] && m[2]) {
      deps.push(m[1].trim(), m[2].trim(), `${m[1].trim()}:${m[2].trim()}`)
    }
  }
  return deps
}

async function harvestMavenPom(
  scanDir: string,
  pomRel: string,
  config: PackageEcosystemConfig,
  rootName: string | null
): Promise<{ candidates: EntityCandidate[]; edges: CandidateEdge[]; artifactId: string | null }> {
  const raw = await readText(path.join(scanDir, pomRel))
  if (!raw) return { candidates: [], edges: [], artifactId: null }
  const artifactId = xmlTag(raw, 'artifactId')
  if (!artifactId) return { candidates: [], edges: [], artifactId: null }
  const groupId = xmlTag(raw, 'groupId')
  const description = xmlTag(raw, 'description') ?? xmlTag(raw, 'name')
  const deps = parseMavenDeps(raw)
  const kind = classifyFromSignals({ deps, packageName: artifactId }, config)
  const aliases = new Set<string>([artifactId])
  if (groupId) aliases.add(`${groupId}:${artifactId}`)
  const candidates: EntityCandidate[] = [
    {
      kind,
      canonicalName: artifactId,
      aliases: [...aliases],
      ...(description ? { gloss: description } : {}),
      sourceFile: pomRel,
      sourceKind: 'manifest',
      contentHash: sha256(raw),
    },
  ]
  const edges: CandidateEdge[] = []
  if (rootName && artifactId !== rootName) {
    edges.push({ fromName: artifactId, toName: rootName, edgeType: 'part_of' })
  }
  return { candidates, edges, artifactId }
}

function parseGradleIncludes(raw: string): string[] {
  const members: string[] = []
  for (const m of raw.matchAll(/include\s*\(?\s*['"]:?([^'"]+)['"]/g)) {
    if (m[1]) members.push(m[1].replace(/:/g, '/'))
  }
  return members
}

export async function harvestJavaEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('java')
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const rootPom = await readText(path.join(scanDir, 'pom.xml'))
  if (rootPom) {
    const root = await harvestMavenPom(scanDir, 'pom.xml', config, null)
    candidates.push(...root.candidates)
    const modules = xmlTags(rootPom, 'module')
    for (const mod of modules) {
      const member = await harvestMavenPom(
        scanDir,
        path.join(mod, 'pom.xml'),
        config,
        root.artifactId
      )
      candidates.push(...member.candidates)
      edges.push(...member.edges)
    }
    return { candidates, edges }
  }

  // Optional Gradle settings include — best-effort when no Maven root.
  for (const settingsName of ['settings.gradle', 'settings.gradle.kts']) {
    const settingsRaw = await readText(path.join(scanDir, settingsName))
    if (!settingsRaw) continue
    const rootNameMatch =
      settingsRaw.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? path.basename(scanDir)
    for (const member of parseGradleIncludes(settingsRaw)) {
      for (const buildName of ['build.gradle.kts', 'build.gradle']) {
        const buildRel = path.join(member, buildName)
        const buildRaw = await readText(path.join(scanDir, buildRel))
        if (!buildRaw) continue
        const name = path.basename(member)
        const deps: string[] = []
        for (const m of buildRaw.matchAll(
          /(?:implementation|api|compileOnly|runtimeOnly)\s*\(?\s*['"]([^'"]+)['"]/g
        )) {
          if (m[1]) {
            const coord = m[1]
            deps.push(coord)
            const parts = coord.split(':')
            if (parts[0]) deps.push(parts[0])
            if (parts[1]) deps.push(parts[1])
          }
        }
        const kind = classifyFromSignals({ deps, packageName: name }, config)
        candidates.push({
          kind,
          canonicalName: name,
          aliases: [name, `:${member.replace(/\//g, ':')}`],
          sourceFile: buildRel,
          sourceKind: 'manifest',
          contentHash: sha256(buildRaw),
        })
        if (rootNameMatch && name !== rootNameMatch) {
          edges.push({ fromName: name, toName: rootNameMatch, edgeType: 'part_of' })
        }
        break
      }
    }
    break
  }

  return { candidates, edges }
}

function parseCabalPackage(raw: string): {
  name: string | null
  deps: string[]
  hasExecutable: boolean
  hasLibrary: boolean
} {
  const name = raw.match(/^name\s*:\s*(\S+)/m)?.[1] ?? null
  const deps: string[] = []
  for (const m of raw.matchAll(/build-depends\s*:\s*([^\n]+(?:\n\s+[^\n]+)*)/gi)) {
    if (!m[1]) continue
    for (const part of m[1].split(',')) {
      const dep = part
        .trim()
        .split(/\s+/)[0]
        ?.replace(/[{].*$/, '')
      if (dep && dep !== 'base' && !dep.startsWith('--')) deps.push(dep)
    }
  }
  return {
    name,
    deps,
    hasExecutable: /^executable\s+/m.test(raw),
    hasLibrary: /^library\b/m.test(raw),
  }
}

function parseHpackPackage(raw: string): {
  name: string | null
  deps: string[]
  hasExecutable: boolean
  hasLibrary: boolean
} {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = loadYaml(raw) as Record<string, unknown>
  } catch {
    return { name: null, deps: [], hasExecutable: false, hasLibrary: false }
  }
  const name = typeof parsed?.name === 'string' ? parsed.name : null
  const deps: string[] = []
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (typeof item === 'string') {
        const dep = item.split(/\s+/)[0]
        if (dep && dep !== 'base') deps.push(dep)
      }
    }
  }
  collect(parsed?.dependencies)
  const library = parsed?.library as Record<string, unknown> | undefined
  collect(library?.dependencies)
  const executables = parsed?.executables as Record<string, unknown> | undefined
  if (executables) {
    for (const exe of Object.values(executables)) {
      collect((exe as Record<string, unknown>)?.dependencies)
    }
  }
  return {
    name,
    deps,
    hasExecutable: Boolean(executables && Object.keys(executables).length > 0),
    hasLibrary: library != null || parsed?.library === true,
  }
}

export async function harvestHaskellEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('haskell')
  const cabalFiles = await listFilesWithExt(scanDir, '.cabal')

  for (const cabalPath of cabalFiles) {
    const raw = await readText(cabalPath)
    if (!raw) continue
    const parsed = parseCabalPackage(raw)
    if (!parsed.name) continue
    const kind = classifyFromSignals(
      {
        deps: parsed.deps,
        hasExecutableStanza: parsed.hasExecutable,
        hasLibraryStanza: parsed.hasLibrary,
      },
      config
    )
    return {
      candidates: [
        {
          kind,
          canonicalName: parsed.name,
          aliases: [parsed.name],
          sourceFile: path.basename(cabalPath),
          sourceKind: 'manifest',
          contentHash: sha256(raw),
        },
      ],
      edges: [],
    }
  }

  const hpackRaw = await readText(path.join(scanDir, 'package.yaml'))
  if (!hpackRaw) return { candidates: [], edges: [] }
  const parsed = parseHpackPackage(hpackRaw)
  if (!parsed.name) return { candidates: [], edges: [] }
  const kind = classifyFromSignals(
    {
      deps: parsed.deps,
      hasExecutableStanza: parsed.hasExecutable,
      hasLibraryStanza: parsed.hasLibrary,
    },
    config
  )
  return {
    candidates: [
      {
        kind,
        canonicalName: parsed.name,
        aliases: [parsed.name],
        sourceFile: 'package.yaml',
        sourceKind: 'manifest',
        contentHash: sha256(hpackRaw),
      },
    ],
    edges: [],
  }
}

function parseCmakeProject(raw: string): string | null {
  // project(Name …) or project(Name)
  const m = raw.match(/^\s*project\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/m)
  return m?.[1] ?? null
}

function parseCmakeDeps(raw: string): string[] {
  const deps: string[] = []
  for (const m of raw.matchAll(/find_package\s*\(\s*([A-Za-z0-9_.-]+)/gi)) {
    if (m[1]) deps.push(m[1].toLowerCase())
  }
  for (const m of raw.matchAll(/target_link_libraries\s*\([^)]*?([A-Za-z0-9_.:-]+)/gi)) {
    if (m[1] && !m[1].startsWith('$')) deps.push(m[1].toLowerCase().replace(/::/g, '.'))
  }
  return deps
}

export async function harvestCppEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('cpp')
  const raw = await readText(path.join(scanDir, 'CMakeLists.txt'))
  if (!raw) return { candidates: [], edges: [] }
  const name = parseCmakeProject(raw)
  if (!name) return { candidates: [], edges: [] }
  const deps = parseCmakeDeps(raw)
  const kind = classifyFromSignals({ deps, packageName: name }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name, path.basename(scanDir)],
        sourceFile: 'CMakeLists.txt',
        sourceKind: 'manifest',
        contentHash: sha256(raw),
      },
    ],
    edges: [],
  }
}

function parseCsproj(raw: string): {
  assemblyName: string | null
  rootNamespace: string | null
  packageId: string | null
  outputType: string | null
  sdks: string[]
  deps: string[]
} {
  const sdkAttr = [...raw.matchAll(/<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/g)]
    .map(m => m[1])
    .filter((v): v is string => Boolean(v))
  const sdks = sdkAttr.flatMap(s =>
    s
      .split(';')
      .map(x => x.trim())
      .filter(Boolean)
  )
  const deps: string[] = []
  for (const m of raw.matchAll(
    /<(?:Package|Framework)Reference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g
  )) {
    if (m[1]) deps.push(m[1])
  }
  return {
    assemblyName: xmlTag(raw, 'AssemblyName'),
    rootNamespace: xmlTag(raw, 'RootNamespace'),
    packageId: xmlTag(raw, 'PackageId'),
    outputType: xmlTag(raw, 'OutputType'),
    sdks,
    deps,
  }
}

function parseSlnProjectPaths(raw: string): Array<{ title: string; relPath: string }> {
  const out: Array<{ title: string; relPath: string }> = []
  for (const m of raw.matchAll(
    /Project\("[^"]+"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+\.(?:cs|fs)proj)"/gi
  )) {
    if (m[1] && m[2]) out.push({ title: m[1], relPath: m[2].replace(/\\/g, '/') })
  }
  return out
}

async function findCsprojFiles(scanDir: string): Promise<string[]> {
  const slnFiles = [
    ...(await listFilesWithExt(scanDir, '.sln')),
    ...(await listFilesWithExt(scanDir, '.slnx')),
  ]
  if (slnFiles.length > 0) {
    const firstSln = slnFiles[0]
    const raw = firstSln ? await readText(firstSln) : null
    if (raw) {
      const fromSln = parseSlnProjectPaths(raw).map(p => path.join(scanDir, p.relPath))
      if (fromSln.length > 0) return fromSln
    }
  }
  const root = await listFilesWithExt(scanDir, '.csproj')
  if (root.length > 0) return root
  // One-level descent for common src/App/App.csproj layouts.
  const found: string[] = []
  try {
    for (const child of await readdir(scanDir)) {
      const full = path.join(scanDir, child)
      if (!(await isDir(full))) continue
      found.push(...(await listFilesWithExt(full, '.csproj')))
    }
  } catch {
    // ignore
  }
  return found
}

export async function harvestCsharpEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('csharp')
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const slnFiles = await listFilesWithExt(scanDir, '.sln')
  const slnName = slnFiles[0] ? path.basename(slnFiles[0], '.sln') : null
  const projects = await findCsprojFiles(scanDir)

  for (const csprojPath of projects) {
    const raw = await readText(csprojPath)
    if (!raw) continue
    const parsed = parseCsproj(raw)
    const stem = path.basename(csprojPath, '.csproj')
    const canonical = parsed.assemblyName ?? parsed.packageId ?? parsed.rootNamespace ?? stem
    const kind = classifyFromSignals(
      {
        deps: parsed.deps,
        packageName: canonical,
        outputType: parsed.outputType ?? undefined,
        sdks: parsed.sdks,
      },
      config
    )
    const aliases = new Set<string>([canonical, stem])
    if (parsed.rootNamespace) aliases.add(parsed.rootNamespace)
    if (parsed.assemblyName) aliases.add(parsed.assemblyName)
    if (parsed.packageId) aliases.add(parsed.packageId)
    candidates.push({
      kind,
      canonicalName: canonical,
      aliases: [...aliases],
      sourceFile: path.relative(scanDir, csprojPath) || path.basename(csprojPath),
      sourceKind: 'manifest',
      contentHash: sha256(raw),
    })
    if (slnName && canonical !== slnName) {
      edges.push({ fromName: canonical, toName: slnName, edgeType: 'part_of' })
    }
  }

  return { candidates, edges }
}

function parseSbtName(raw: string): string | null {
  return (
    raw.match(/^\s*name\s*:=\s*"([^"]+)"/m)?.[1] ??
    raw.match(/^\s*name\s*:=\s*'([^']+)'/m)?.[1] ??
    null
  )
}

function parseSbtDeps(raw: string): string[] {
  const deps: string[] = []
  // "org" %% "artifact" % "ver" or %%%
  for (const m of raw.matchAll(/["']([A-Za-z0-9_.-]+)["']\s*%{1,3}\s*["']([A-Za-z0-9_.-]+)["']/g)) {
    if (m[1] && m[2]) {
      deps.push(m[2], m[1], `${m[1]}:${m[2]}`)
    }
  }
  for (const m of raw.matchAll(/EnablePlugins\(\s*([A-Za-z0-9_,\s]+)\)/g)) {
    if (m[1]) {
      for (const p of m[1].split(',')) {
        const name = p.trim()
        if (name) deps.push(name)
      }
    }
  }
  return deps
}

export async function harvestScalaEcosystem(scanDir: string): Promise<HarvestResult> {
  const config = loadPackageEcosystemConfig('scala')
  const raw = await readText(path.join(scanDir, 'build.sbt'))
  if (!raw) return { candidates: [], edges: [] }
  const name = parseSbtName(raw)
  if (!name) return { candidates: [], edges: [] }
  const deps = parseSbtDeps(raw)
  const kind = classifyFromSignals({ deps, packageName: name }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name, path.basename(scanDir)],
        sourceFile: 'build.sbt',
        sourceKind: 'manifest',
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
