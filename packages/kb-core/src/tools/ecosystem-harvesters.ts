/**
 * Ecosystem harvesters — the deterministic half of the `entity-index` scan cycle
 * (NOMENCLATURE_INDEX_PLAN.md §4a). A harvester answers "what deployable things
 * does this repo declare" from manifest-class files: pure functions from a scan
 * directory to entity candidates, no LLM, no network.
 *
 * Coverage (frameworks, kind rubric, compose/fly/Backstage/k8s/Helm/Procfile,
 * OpenAPI/protobuf contracts, best-effort routes / app-layer classes / ORM
 * models, declared gaps for symbols) lives in YAML under `tools/ecosystems/`
 * — one file per ecosystem — so scope is code-reviewable without reading the
 * inference code. This module loads those configs and runs the harvest.
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
function packageBinNames(bin: PackageJson['bin']): string[] {
  if (!bin) return []
  if (typeof bin === 'string') return [path.basename(bin)]
  return Object.keys(bin)
}

export function classifyPackageKind(
  pkg: PackageJson,
  config: TypescriptEcosystemConfig = loadTypescriptEcosystemConfig()
): { kind: EntityKind; confidence: number } {
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
      pushCandidate({
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
        pushCandidate({
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
          confidence: config.kubernetes.confidence,
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
        confidence: config.helm.confidence,
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
    confidence: config.procfile.confidence,
    contentHash: sha256(raw),
  })
}

const OPENAPI_CONFIDENCE = 0.9
const PROTO_CONFIDENCE = 0.85
const ROUTE_CONFIDENCE = 0.5
const ROUTE_CAP = 200
const OPENAPI_PATH_CONFIDENCE = 0.75

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
        confidence: OPENAPI_CONFIDENCE,
        contentHash: hash,
      })
    }
    // Path items (and per-verb operations) — denser than title alone.
    // Same-document `$ref` path items are expanded when feasible.
    const paths = parsed?.paths
    if (paths && typeof paths === 'object') {
      for (const [routePath, item] of Object.entries(paths)) {
        if (!routePath.startsWith('/') || !isPlausibleHttpRoute(routePath)) continue
        push({
          kind: 'api',
          canonicalName: routePath,
          aliases: [routePath],
          gloss: 'OpenAPI path item',
          sourceFile: rel,
          sourceKind: 'manifest',
          confidence: OPENAPI_PATH_CONFIDENCE,
          contentHash: hash,
        })
        let resolved: unknown = item
        if (
          item &&
          typeof item === 'object' &&
          '$ref' in item &&
          typeof (item as { $ref?: unknown }).$ref === 'string'
        ) {
          resolved = resolveOpenApiRef(parsed, (item as { $ref: string }).$ref)
        }
        if (!resolved || typeof resolved !== 'object') continue
        for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
          if (!(verb in (resolved as Record<string, unknown>))) continue
          const name = `${verb.toUpperCase()} ${routePath}`
          if (!isPlausibleHttpRoute(name)) continue
          push({
            kind: 'api',
            canonicalName: name,
            aliases: [name],
            gloss: 'OpenAPI operation',
            sourceFile: rel,
            sourceKind: 'manifest',
            confidence: OPENAPI_PATH_CONFIDENCE,
            contentHash: hash,
          })
        }
      }
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
        confidence: PROTO_CONFIDENCE,
        contentHash: sha256(raw),
      })
    }
  }

  return { candidates, edges: [] }
}

const APP_SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.rb',
  '.cs',
  '.php',
  '.rs',
  '.scala',
  '.hs',
  '.lhs',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.prisma',
  '.sql',
  '.graphql',
  '.gql',
  '.xml',
])

const ROUTE_SOURCE_EXT = new Set([
  ...APP_SOURCE_EXT,
  '.yaml',
  '.yml',
])

const ROUTE_FILE_EXT_RE =
  /\.(pem|crt|key|py|ts|tsx|js|jsx|mjs|cjs|go|java|kt|rb|cs|php|rs|scala|hs|cpp|cc|h|hpp|prisma|sql|graphql|gql|md|json|mitm|ya?ml|toml|txt|png|jpg|svg)$/i

const APP_CONCEPT_CONFIDENCE = 0.55
const APP_CONCEPT_CAP = 160
const MODEL_CAP = 160

const BANNED_TYPE_NAMES = new Set([
  'String',
  'Integer',
  'Boolean',
  'Object',
  'List',
  'Map',
  'Array',
  'Promise',
  'Optional',
  'Type',
  'Class',
  'Interface',
  'Enum',
  'Error',
  'Exception',
  'Test',
  'Mock',
  'Stub',
  'Fixture',
  'Base',
  'Model',
  'Entity',
  'Controller',
  'Service',
  'Repository',
  'Handler',
  'Component',
  'Module',
  'Config',
  'Configuration',
  'Application',
  'Program',
  'Main',
])

/**
 * Reject filesystem / fixture strings that the decorator regexes commonly steal
 * (e.g. mitmproxy `path("mitmproxy/data/…")` false positives).
 */
export function isPlausibleHttpRoute(raw: string): boolean {
  const methodMatch = raw.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)\s+(.+)$/i)
  const p = (methodMatch?.[2] ?? raw).trim()
  if (!p || p.length > 120) return false
  if (p.includes('..') || p.includes('\\')) return false
  if (ROUTE_FILE_EXT_RE.test(p)) return false
  if (/^(?:\.\.?\/|[A-Za-z]:)/.test(p)) return false
  // Relative tree paths mistaken for routes
  if (/^(?:mitmproxy|test|tests|examples|fixtures|testdata|node_modules)\//i.test(p)) return false
  // Nest/Spring controller segment without leading slash
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(p)) return true
  // Absolute HTTP path or Django-style trailing-slash path
  if (p.startsWith('/')) return true
  if (/^[A-Za-z0-9_./:[\]{}*-]+\/?$/.test(p) && !p.includes(' ')) return true
  return false
}

/** PascalCase app type (controller/service/model class). */
export function isPlausibleTypeName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 80) return false
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) return false
  if (BANNED_TYPE_NAMES.has(name)) return false
  if (/Test$|Spec$|Mock$|Stub$/.test(name)) return false
  return true
}

/** ORM model / table identifier (PascalCase or snake_case). */
export function isPlausibleModelName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 80) return false
  if (/^(tmp_|temp_|test_|pg_|sqlite_)/i.test(name)) return false
  if (BANNED_TYPE_NAMES.has(name)) return false
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return true
  if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) return true
  if (/^[a-z][a-z0-9]*$/.test(name) && name.length >= 3) return true
  return false
}

export type NextRouteHit = { path: string; kind: 'api' | 'surface' }

/** Next.js App Router / Pages Router file → URL path + kind (page=surface, route/api=api). */
export function nextRouteFromFile(relPosix: string): NextRouteHit | null {
  const norm = relPosix.replace(/\\/g, '/')
  let m = norm.match(/^(?:src\/)?app\/(.+)\/(page|route)\.(tsx?|jsx?|mjs|cjs)$/)
  if (m?.[1] && m[2]) {
    const segs = m[1]
      .split('/')
      .filter(s => !(s.startsWith('(') && s.endsWith(')'))) // route groups
      .filter(s => s !== 'page' && s !== 'route')
    const routePath = segs.length === 0 ? '/' : `/${segs.join('/')}`
    return { path: routePath, kind: m[2] === 'page' ? 'surface' : 'api' }
  }
  m = norm.match(/^(?:src\/)?pages\/api\/(.+)\.(tsx?|jsx?|mjs|cjs)$/)
  if (m?.[1]) {
    const apiPath = m[1].replace(/\/index$/, '')
    return { path: `/api/${apiPath}`, kind: 'api' }
  }
  m = norm.match(/^(?:src\/)?pages\/(.+)\.(tsx?|jsx?)$/)
  if (m?.[1]) {
    const page = m[1]
    if (page.startsWith('api/')) return null
    if (/^(_app|_document|_error|_middleware)/.test(page)) return null
    const cleaned = page.replace(/\/index$/, '')
    return { path: cleaned === 'index' ? '/' : `/${cleaned}`, kind: 'surface' }
  }
  return null
}

/** Join class/controller prefix with a method segment (`/api` + `users` → `/api/users`). */
export function joinHttpPaths(base: string, segment: string): string {
  const a = (base ?? '').trim()
  const b = (segment ?? '').trim()
  if (!a) return b.startsWith('/') || !b ? b || '/' : `/${b}`
  if (!b || b === '/') {
    return a.startsWith('/') ? a.replace(/\/+$/, '') || '/' : `/${a.replace(/\/+$/, '')}`
  }
  const left = a.replace(/\/+$/, '')
  const right = b.replace(/^\/+/, '')
  const joined = `${left}/${right}`
  return joined.startsWith('/') ? joined : `/${joined}`
}

/** Rails `resources :x` → standard seven CRUD route shapes (collection + member). */
export function expandRailsResourceRoutes(resource: string): string[] {
  const base = resource.startsWith('/') ? resource : `/${resource}`
  const member = `${base}/:id`
  return [
    base,
    `GET ${base}`,
    `POST ${base}`,
    `GET ${member}`,
    `PUT ${member}`,
    `PATCH ${member}`,
    `DELETE ${member}`,
  ]
}

type SpringHit = { method: string | null; path: string }

function springAnnoPath(annoBlock: string): string | null {
  const m = annoBlock.match(
    /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]+)['"]/
  )
  return m?.[1] ?? null
}

function springMethodHits(raw: string): SpringHit[] {
  const found: SpringHit[] = []
  const methodByAnno: Record<string, string | null> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    PatchMapping: 'PATCH',
    DeleteMapping: 'DELETE',
  }
  for (const [anno, method] of Object.entries(methodByAnno)) {
    const re = new RegExp(`@${anno}\\s*\\(\\s*(?:(?:value|path)\\s*=\\s*)?['"]([^'"]+)['"]`, 'g')
    for (const m of raw.matchAll(re)) {
      if (m[1]) found.push({ method, path: m[1] })
    }
  }
  // @RequestMapping(method = RequestMethod.GET, value = "/x") on methods
  for (const m of raw.matchAll(
    /@RequestMapping\s*\([^)]*method\s*=\s*RequestMethod\.([A-Z]+)[^)]*(?:value|path)\s*=\s*['"]([^'"]+)['"]/g
  )) {
    if (m[1] && m[2]) found.push({ method: m[1], path: m[2] })
  }
  for (const m of raw.matchAll(
    /@RequestMapping\s*\([^)]*(?:value|path)\s*=\s*['"]([^'"]+)['"][^)]*method\s*=\s*RequestMethod\.([A-Z]+)/g
  )) {
    if (m[1] && m[2]) found.push({ method: m[2], path: m[1] })
  }
  // Path-only @RequestMapping("/x") used as method mapping (no RequestMethod)
  for (const m of raw.matchAll(
    /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]+)['"]\s*\)/g
  )) {
    if (m[1]) found.push({ method: null, path: m[1] })
  }
  return found
}

/**
 * Spring MVC/WebFlux mappings with class-level `@RequestMapping` joined to
 * method-level `@GetMapping` / `@PostMapping` / … (`/api` + `/users` → `/api/users`).
 */
function springMappingPaths(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }

  type ClassSpan = { prefix: string | null; bodyStart: number; bodyEnd: number }
  const classes: ClassSpan[] = []
  const classDeclRe =
    /((?:^[ \t]*@[^\n]+\n)+)[ \t]*(?:public\s+|protected\s+|private\s+|internal\s+|open\s+)?(?:class|interface|object)\s+[A-Z][A-Za-z0-9_]*/gm
  for (const m of raw.matchAll(classDeclRe)) {
    const annos = m[1] ?? ''
    const prefix = springAnnoPath(annos)
    const declEnd = (m.index ?? 0) + m[0].length
    const brace = raw.indexOf('{', declEnd)
    if (brace < 0) continue
    classes.push({ prefix, bodyStart: brace + 1, bodyEnd: raw.length })
  }
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]
    if (!cls) continue
    const next = classes[i + 1]
    cls.bodyEnd = next ? (next.bodyStart - 1) : raw.length
  }

  if (classes.length === 0) {
    for (const hit of springMethodHits(raw)) {
      const path = hit.path || '/'
      push(hit.method ? `${hit.method} ${path}` : path)
    }
    return found
  }

  for (const cls of classes) {
    if (cls.prefix) push(cls.prefix)
    const body = raw.slice(cls.bodyStart, cls.bodyEnd)
    // Method hits only — exclude a leading class-level @RequestMapping re-scan by
    // stripping path-only RequestMapping that equals the class prefix when joined.
    for (const hit of springMethodHits(body)) {
      // Skip class-prefix re-capture: path-only RequestMapping equal to prefix
      if (
        hit.method === null &&
        cls.prefix &&
        (hit.path === cls.prefix || joinHttpPaths(cls.prefix, '') === hit.path)
      ) {
        continue
      }
      // Skip path-only @RequestMapping that is clearly the class annotation echoed
      // at the top of the body slice (should not happen — body starts after `{`).
      const joined = cls.prefix ? joinHttpPaths(cls.prefix, hit.path || '') : hit.path || '/'
      if (!joined || joined === '/') {
        if (hit.method && cls.prefix) push(`${hit.method} ${cls.prefix}`)
        continue
      }
      push(hit.method ? `${hit.method} ${joined}` : joined)
    }
  }
  return found
}

/** NestJS `@Controller('x')` + `@Get('y')` → `GET /x/y`. */
function nestJoinedRoutes(raw: string): Array<{ name: string; alias?: string }> {
  const found: Array<{ name: string; alias?: string }> = []
  const seen = new Set<string>()
  const push = (name: string, alias?: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push(alias ? { name, alias } : { name })
  }

  type Ctrl = { prefix: string; bodyStart: number; bodyEnd: number }
  const ctrls: Ctrl[] = []
  const ctrlRe =
    /@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)[\s\S]{0,200}?export\s+class\s+[A-Z][A-Za-z0-9_]*/g
  for (const m of raw.matchAll(ctrlRe)) {
    const prefix = m[1] ?? ''
    const declEnd = (m.index ?? 0) + m[0].length
    const brace = raw.indexOf('{', declEnd)
    if (brace < 0) continue
    ctrls.push({ prefix, bodyStart: brace + 1, bodyEnd: raw.length })
  }
  for (let i = 0; i < ctrls.length; i++) {
    const c = ctrls[i]
    if (!c) continue
    const nextCtrl = ctrls[i + 1]
    c.bodyEnd = nextCtrl ? nextCtrl.bodyStart - 1 : raw.length
    if (c.prefix) push(c.prefix, c.prefix)
    const body = raw.slice(c.bodyStart, c.bodyEnd)
    for (const hm of body.matchAll(
      /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*(?:\(\s*(?:['"]([^'"]*)['"])?\s*\))?/g
    )) {
      const verbRaw = (hm[1] ?? 'GET').toUpperCase()
      const method = verbRaw === 'ALL' ? 'ANY' : verbRaw
      const seg = hm[2] ?? ''
      const joined = joinHttpPaths(c.prefix, seg)
      push(`${method} ${joined}`)
    }
  }

  // Controllers without a matched class body still emit @Controller('x')
  if (ctrls.length === 0) {
    for (const m of raw.matchAll(/@Controller\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1]) push(m[1], m[1])
    }
    for (const m of raw.matchAll(
      /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    )) {
      if (m[1] && m[2]) {
        const method = m[1].toUpperCase() === 'ALL' ? 'ANY' : m[1].toUpperCase()
        push(`${method} ${m[2]}`)
      }
    }
  }
  return found
}

/**
 * Raw Node.js `http` dispatch: `method === 'POST' && url === '/v1/query'`,
 * `pathname === '/healthz'`, `url.startsWith('/v1/facts')`, `URLPattern`.
 * Captures framework-free servers (kb-server style).
 */
export function rawNodeHttpRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  const pathExpr = '(?:url|pathname|path|req\\.url|request\\.url)'
  const verb = '(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)'

  // Same line: method === 'GET' && (url === '/healthz' || url === '/health')
  for (const line of raw.split('\n')) {
    const verbMatch = line.match(new RegExp(`\\bmethod\\s*===\\s*['"]${verb}['"]`, 'i'))
    if (verbMatch?.[1]) {
      const method = verbMatch[1].toUpperCase()
      const pathRe = new RegExp(`\\b${pathExpr}\\s*(?:===|==)\\s*['"](\\/[^'"]+)['"]`, 'g')
      for (const pm of line.matchAll(pathRe)) {
        if (pm[1]) push(`${method} ${pm[1]}`)
      }
    }
    // pathname === '/x' && method === 'POST' on one line
    const pathVerb = line.match(
      new RegExp(
        `\\b${pathExpr}\\s*(?:===|==)\\s*['"](\\/[^'"]+)['"]\\s*&&\\s*method\\s*===\\s*['"]${verb}['"]`,
        'i'
      )
    )
    if (pathVerb?.[1] && pathVerb[2]) {
      push(`${pathVerb[2].toUpperCase()} ${pathVerb[1]}`)
    }
  }
  // Bare equality / startsWith (path without verb — still an API surface)
  const barePath = new RegExp(
    `\\b${pathExpr}\\s*(?:===|==)\\s*['"](\\/[^'"]+)['"]`,
    'g'
  )
  for (const m of raw.matchAll(barePath)) {
    if (m[1]) push(m[1])
  }
  const startsWith = new RegExp(
    `\\b${pathExpr}\\s*\\.startsWith\\s*\\(\\s*['"](\\/[^'"]+)['"]`,
    'g'
  )
  for (const m of raw.matchAll(startsWith)) {
    if (m[1]) push(m[1])
  }
  // new URLPattern({ pathname: '/users/:id' }) | new URLPattern('/users/:id')
  for (const m of raw.matchAll(
    /new\s+URLPattern\s*\(\s*(?:\{[^}]*\bpathname\s*:\s*['"]([^'"]+)['"]|['"]([^'"]+)['"])/g
  )) {
    const p = m[1] ?? m[2]
    if (p?.startsWith('/')) push(p)
  }
  return found
}

/** Nest `setGlobalPrefix('api')` joined with same-file `@Controller` routes. */
function nestGlobalPrefixRoutes(raw: string): Array<{ name: string; alias?: string }> {
  const found: Array<{ name: string; alias?: string }> = []
  const seen = new Set<string>()
  const push = (name: string, alias?: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push(alias ? { name, alias } : { name })
  }
  const prefixes: string[] = []
  for (const m of raw.matchAll(/\.setGlobalPrefix\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) prefixes.push(m[1].replace(/^\/+|\/+$/g, ''))
  }
  // RouterModule.register([{ path: 'admin', module: … }])
  if (/\bRouterModule\b/.test(raw)) {
    for (const m of raw.matchAll(
      /\bpath\s*:\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]\s*,\s*module\s*:/g
    )) {
      if (m[1]) push(`/${m[1]}`, m[1])
    }
  }
  if (prefixes.length === 0) return found
  const nested = nestJoinedRoutes(raw)
  for (const prefix of prefixes) {
    push(`/${prefix}`, prefix)
    for (const hit of nested) {
      const methodMatch = hit.name.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)\s+(.+)$/i)
      if (methodMatch?.[1] && methodMatch[2]) {
        push(`${methodMatch[1].toUpperCase()} ${joinHttpPaths(prefix, methodMatch[2])}`)
      } else {
        push(joinHttpPaths(prefix, hit.name))
      }
    }
  }
  return found
}

/**
 * FastAPI `APIRouter(prefix="/v1")` + `@router.get("/users")` same-file join;
 * also `include_router(..., prefix=)`.
 */
function fastapiRouterPrefixRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }

  // var = APIRouter(prefix="/v1")
  const varPrefixes = new Map<string, string>()
  for (const m of raw.matchAll(
    /\b([A-Za-z_][\w]*)\s*=\s*APIRouter\s*\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/g
  )) {
    if (m[1] && m[2]) varPrefixes.set(m[1], m[2])
  }
  // Bare APIRouter(prefix=) without assignment — treat as default router
  const barePrefixes: string[] = []
  for (const m of raw.matchAll(/APIRouter\s*\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) barePrefixes.push(m[1])
  }
  for (const m of raw.matchAll(
    /\.include_router\s*\([^,)]+,\s*prefix\s*=\s*['"]([^'"]+)['"]/g
  )) {
    if (m[1]) barePrefixes.push(m[1])
  }

  for (const [varName, prefix] of varPrefixes) {
    const deco = new RegExp(
      `@${varName}\\.(get|post|put|patch|delete|options|head)\\s*\\(\\s*['"]([^'"]+)['"]`,
      'gi'
    )
    for (const hm of raw.matchAll(deco)) {
      if (hm[1] && hm[2]) {
        push(`${hm[1].toUpperCase()} ${joinHttpPaths(prefix, hm[2])}`)
      }
    }
  }
  // @router.get when a single bare prefix exists
  if (barePrefixes.length === 1) {
    const prefix = barePrefixes[0] ?? ''
    for (const hm of raw.matchAll(
      /@(?:router|api_router|api)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi
    )) {
      if (hm[1] && hm[2]) {
        push(`${hm[1].toUpperCase()} ${joinHttpPaths(prefix, hm[2])}`)
      }
    }
  }
  for (const p of barePrefixes) {
    if (p) push(p.startsWith('/') ? p : `/${p}`)
  }
  return found
}

/** Gin/chi `x := r.Group("/v1")` + `x.GET("/users", …)` same-file join. */
function goGroupPrefixRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  for (const m of raw.matchAll(
    /\b([A-Za-z_]\w*)\s*(?::?=)\s*\w+\.Group\s*\(\s*"(\/[^"]*)"/g
  )) {
    const varName = m[1]
    const prefix = m[2]
    if (!varName || !prefix) continue
    push(prefix)
    const verbRe = new RegExp(
      `\\b${varName}\\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle|Get|Post|Put|Patch|Delete)\\s*\\(\\s*"([^"]+)"`,
      'g'
    )
    for (const hm of raw.matchAll(verbRe)) {
      const verb = (hm[1] ?? 'GET').toUpperCase()
      const method = verb === 'ANY' || verb === 'HANDLE' ? 'ANY' : verb
      const seg = hm[2]
      if (seg) push(`${method} ${joinHttpPaths(prefix, seg)}`)
    }
  }
  // Unassigned Group("/api") / chi Route already partially covered — emit prefix
  for (const m of raw.matchAll(/\b\w+\.Group\s*\(\s*"(\/[^"]*)"/g)) {
    if (m[1]) push(m[1])
  }
  return found
}

/**
 * Rails `namespace` / `scope` stack joined with nested `resources` / verb routes
 * (indentation-light `do`/`end` scan of routes.rb).
 */
export function railsNestedRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  const stack: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const ns = trimmed.match(/^namespace\s+:([a-z][a-z0-9_]*)/)
    const scopeStr = trimmed.match(/^scope\s+['"]([^'"]+)['"]/)
    const scopeSym = trimmed.match(/^scope\s+:([a-z][a-z0-9_]*)/)
    const pathPrefix = trimmed.match(/^scope\s+path:\s*['"]([^'"]+)['"]/)

    let pushed = false
    if (ns?.[1]) {
      stack.push(`/${ns[1]}`)
      pushed = true
      push(`/${ns[1]}`)
    } else if (scopeStr?.[1]) {
      const seg = scopeStr[1].startsWith('/') ? scopeStr[1] : `/${scopeStr[1]}`
      stack.push(seg)
      pushed = true
      push(seg)
    } else if (scopeSym?.[1]) {
      stack.push(`/${scopeSym[1]}`)
      pushed = true
      push(`/${scopeSym[1]}`)
    } else if (pathPrefix?.[1]) {
      const seg = pathPrefix[1].startsWith('/') ? pathPrefix[1] : `/${pathPrefix[1]}`
      stack.push(seg)
      pushed = true
      push(seg)
    }

    const prefix = stack.length ? stack.join('').replace(/\/+/g, '/') : ''

    for (const m of trimmed.matchAll(/\bresources\s+:([a-z][a-z0-9_]*)/g)) {
      if (!m[1]) continue
      const base = prefix ? joinHttpPaths(prefix, m[1]) : `/${m[1]}`
      for (const r of expandRailsResourceRoutes(base.replace(/^\//, ''))) push(r)
    }
    for (const m of trimmed.matchAll(/\bresource\s+:([a-z][a-z0-9_]*)/g)) {
      if (!m[1]) continue
      const base = prefix ? joinHttpPaths(prefix, m[1]) : `/${m[1]}`
      push(base)
      push(`GET ${base}`)
      push(`POST ${base}`)
      push(`PUT ${base}`)
      push(`PATCH ${base}`)
      push(`DELETE ${base}`)
    }
    for (const m of trimmed.matchAll(
      /\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]/g
    )) {
      if (!m[2]) continue
      const seg = m[2].startsWith('/') ? m[2] : `/${m[2]}`
      const joined = prefix ? joinHttpPaths(prefix, seg) : seg
      const verb = (m[1] ?? 'get').toUpperCase()
      if (verb === 'MATCH') push(joined)
      else push(`${verb} ${joined}`)
    }

    // Pop stack on `end` that closes a namespace/scope block we pushed
    if (/^end\b/.test(trimmed) && stack.length > 0 && !pushed) {
      stack.pop()
    }
  }
  return found
}

/** Micronaut `@Controller("/api")` + `@Get("/users")` join. */
function micronautJoinedRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  type Ctrl = { prefix: string; bodyStart: number; bodyEnd: number }
  const ctrls: Ctrl[] = []
  const ctrlRe =
    /@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)[\s\S]{0,200}?(?:public\s+|internal\s+|open\s+)?(?:class|object)\s+[A-Z][A-Za-z0-9_]*/g
  for (const m of raw.matchAll(ctrlRe)) {
    const prefix = m[1] ?? ''
    const declEnd = (m.index ?? 0) + m[0].length
    const brace = raw.indexOf('{', declEnd)
    if (brace < 0) continue
    ctrls.push({ prefix, bodyStart: brace + 1, bodyEnd: raw.length })
  }
  for (let i = 0; i < ctrls.length; i++) {
    const c = ctrls[i]
    if (!c) continue
    const next = ctrls[i + 1]
    c.bodyEnd = next ? next.bodyStart - 1 : raw.length
    if (c.prefix) push(c.prefix.startsWith('/') ? c.prefix : `/${c.prefix}`)
    const body = raw.slice(c.bodyStart, c.bodyEnd)
    for (const hm of body.matchAll(
      /@(Get|Post|Put|Patch|Delete|Head|Options|Trace)\s*(?:\(\s*(?:(?:uri|value)\s*=\s*)?['"]([^'"]*)['"]\s*\))?/g
    )) {
      const method = (hm[1] ?? 'GET').toUpperCase()
      const seg = hm[2] ?? ''
      const joined = joinHttpPaths(c.prefix, seg)
      push(`${method} ${joined}`)
    }
  }
  return found
}

/** JAX-RS / Quarkus `@Path` on class joined with method `@GET` + `@Path`. */
function jaxrsJoinedRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  type Res = { prefix: string; bodyStart: number; bodyEnd: number }
  const resources: Res[] = []
  const classRe =
    /@Path\s*\(\s*['"]([^'"]*)['"]\s*\)[\s\S]{0,300}?(?:public\s+|protected\s+)?(?:class|interface)\s+[A-Z][A-Za-z0-9_]*/g
  for (const m of raw.matchAll(classRe)) {
    const prefix = m[1] ?? ''
    const declEnd = (m.index ?? 0) + m[0].length
    const brace = raw.indexOf('{', declEnd)
    if (brace < 0) continue
    resources.push({ prefix, bodyStart: brace + 1, bodyEnd: raw.length })
  }
  for (let i = 0; i < resources.length; i++) {
    const res = resources[i]
    if (!res) continue
    const next = resources[i + 1]
    res.bodyEnd = next ? next.bodyStart - 1 : raw.length
    if (res.prefix) push(res.prefix.startsWith('/') ? res.prefix : `/${res.prefix}`)
    const body = raw.slice(res.bodyStart, res.bodyEnd)
    // Split on method annotations roughly: @GET ... @Path("/x") or @Path then @GET
    for (const hm of body.matchAll(
      /@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[\s\S]{0,120}?@Path\s*\(\s*['"]([^'"]*)['"]\s*\)/g
    )) {
      if (hm[1] && hm[2] !== undefined) {
        push(`${hm[1]} ${joinHttpPaths(res.prefix, hm[2])}`)
      }
    }
    for (const hm of body.matchAll(
      /@Path\s*\(\s*['"]([^'"]*)['"]\s*\)[\s\S]{0,80}?@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g
    )) {
      if (hm[1] !== undefined && hm[2]) {
        push(`${hm[2]} ${joinHttpPaths(res.prefix, hm[1])}`)
      }
    }
  }
  return found
}

/** Starlette/ASGI/Datasette-style `Route` / `Mount` / `add_route`. */
function asgiStyleRoutes(raw: string): Array<{ name: string }> {
  const found: Array<{ name: string }> = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push({ name })
  }
  for (const m of raw.matchAll(
    /\b(?:Route|Mount|WebSocketRoute)\s*\(\s*['"](\/[^'"]+)['"]/g
  )) {
    if (m[1]) push(m[1])
  }
  for (const m of raw.matchAll(/\.add_route\s*\(\s*['"](\/[^'"]+)['"]/g)) {
    if (m[1]) push(m[1])
  }
  for (const m of raw.matchAll(
    /\badd_api_route\s*\(\s*['"](\/[^'"]+)['"]/g
  )) {
    if (m[1]) push(m[1])
  }
  return found
}

/** Resolve a same-document OpenAPI JSON Pointer (`#/components/...`). */
function resolveOpenApiRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return null
  const parts = ref
    .slice(2)
    .split('/')
    .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur: unknown = doc
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur ?? null
}

function pushUniqueCandidate(
  candidates: EntityCandidate[],
  seen: Set<string>,
  cap: number,
  c: EntityCandidate
): void {
  if (candidates.length >= cap) return
  const key = `${c.kind}\0${c.canonicalName}`
  if (seen.has(key)) return
  seen.add(key)
  candidates.push(c)
}

/**
 * Tier-4 in-code route/decorator harvest — best-effort regex + Next.js
 * filesystem routes, low confidence, capped. Never load-bearing.
 * Next.js `page` files emit `surface`; API/route handlers emit `api`.
 */
/** Django `path('api/', include('users.urls'))` → module key `users.urls`. */
function djangoIncludeModuleKey(expr: string): string | null {
  const m = expr.match(/^\s*['"]([A-Za-z_][A-Za-z0-9_.]*)['"]\s*$/)
  return m?.[1] ?? null
}

/** Map a Django urls module (`users.urls`) to likely repo-relative file paths. */
function djangoUrlsModuleFiles(module: string): string[] {
  const parts = module.split('.')
  if (parts.length === 0) return []
  const base = parts.join('/')
  return [`${base}.py`, `${base}/__init__.py`]
}

function djangoJoinPrefix(prefix: string, segment: string): string {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  const s = segment.replace(/^\//, '')
  return `${p}${s}`
}

export async function harvestRouteDecorators(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const seen = new Set<string>()
  const files = await walkFiles(scanDir, { extensions: ROUTE_SOURCE_EXT, maxFiles: 2500 })
  // Play conf/routes has no extension — pick up by basename.
  for (const f of await walkFiles(scanDir, { basenames: new Set(['routes']), maxFiles: 50 })) {
    const relPosix = path.relative(scanDir, f).replace(/\\/g, '/')
    if (relPosix === 'conf/routes' || relPosix.endsWith('/conf/routes')) {
      files.push(f)
    }
  }

  // Django include() → child urls module prefixes (cross-file join).
  const djangoModulePrefixes = new Map<string, string[]>()
  for (const filePath of files) {
    if (path.extname(filePath).toLowerCase() !== '.py') continue
    const raw = await readText(filePath)
    if (!raw || !raw.includes('include(')) continue
    for (const m of raw.matchAll(
      /\bpath\s*\(\s*['"]([^'"]+)['"]\s*,\s*include\s*\(\s*([^)]+?)\s*\)/g
    )) {
      const prefix = m[1]
      const mod = m[2] ? djangoIncludeModuleKey(m[2]) : null
      if (!prefix || !mod) continue
      const list = djangoModulePrefixes.get(mod) ?? []
      list.push(prefix)
      djangoModulePrefixes.set(mod, list)
    }
  }

  const pushHit = (
    name: string,
    rel: string,
    hash: string,
    kind: EntityKind = 'api',
    alias?: string,
    gloss?: string
  ) => {
    if (kind === 'api' && !isPlausibleHttpRoute(name)) return
    if (kind === 'surface' && !isPlausibleHttpRoute(name)) return
    pushUniqueCandidate(candidates, seen, ROUTE_CAP, {
      kind,
      canonicalName: name,
      aliases: alias ? [name, alias] : [name],
      ...(gloss ? { gloss } : {}),
      sourceFile: rel,
      sourceKind: 'manifest',
      confidence: ROUTE_CONFIDENCE,
      contentHash: hash,
    })
  }

  for (const filePath of [...new Set(files)].sort()) {
    if (candidates.length >= ROUTE_CAP) break
    const rel = path.relative(scanDir, filePath)
    const relPosix = rel.replace(/\\/g, '/')
    const ext = path.extname(relPosix).toLowerCase()

    // Next.js filesystem routes (no need to open file for path shape)
    const nextHit = nextRouteFromFile(relPosix)
    if (nextHit) {
      pushHit(
        nextHit.path,
        rel,
        sha256(relPosix),
        nextHit.kind,
        nextHit.path,
        nextHit.kind === 'surface' ? 'Next.js page' : 'Next.js route handler'
      )
    }

    // Play Framework conf/routes (no extension)
    if (relPosix === 'conf/routes' || relPosix.endsWith('/conf/routes')) {
      const rawRoutes = await readText(filePath)
      if (rawRoutes) {
        const hash = sha256(rawRoutes)
        for (const m of rawRoutes.matchAll(
          /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/gm
        )) {
          if (m[1] && m[2]) pushHit(`${m[1]} ${m[2]}`, rel, hash)
        }
      }
      continue
    }

    const raw = await readText(filePath)
    if (!raw) continue
    const hash = sha256(raw)
    const found: Array<{ name: string; alias?: string }> = []

    // NestJS: join @Controller('payments') + @Get/@Post('…') + setGlobalPrefix
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      found.push(...nestJoinedRoutes(raw))
      found.push(...nestGlobalPrefixRoutes(raw))
      // Raw node:http dispatch (kb-server style) + URLPattern
      found.push(...rawNodeHttpRoutes(raw))
      // tRPC procedure names on routers
      for (const m of raw.matchAll(
        /\b([a-z][A-Za-z0-9_]*)\s*:\s*(?:publicProcedure|protectedProcedure|privateProcedure|procedure)\b/g
      )) {
        if (m[1]) found.push({ name: `trpc/${m[1]}` })
      }
      for (const m of raw.matchAll(
        /\b([a-z][A-Za-z0-9_]*)\s*:\s*\w*Procedure\s*\.(?:query|mutation|subscription)\b/g
      )) {
        if (m[1]) found.push({ name: `trpc/${m[1]}` })
      }
    }
    // Express / Koa / Hono: app.get('/path' | router.post("/path" | hono.get(
    for (const m of raw.matchAll(
      /\b(?:app|router|r|hono|api)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"]([^'"]+)['"]/gi
    )) {
      const method = (m[1] ?? 'GET').toUpperCase()
      const routePath = m[2]
      if (routePath) found.push({ name: `${method} ${routePath}` })
    }
    // FastAPI / Starlette: @app.get("/path") | @router.post('/path') | @api_router.get
    for (const m of raw.matchAll(
      /@(?:app|router|api_router|api)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi
    )) {
      const method = (m[1] ?? 'GET').toUpperCase()
      const routePath = m[2]
      if (routePath) found.push({ name: `${method} ${routePath}` })
    }
    // Flask: @app.route / @bp.route / @blueprint.route + MethodView add_url_rule
    if (ext === '.py') {
      found.push(...fastapiRouterPrefixRoutes(raw))
      found.push(...asgiStyleRoutes(raw))
      for (const m of raw.matchAll(/@(?:app|bp|blueprint)\.route\s*\(\s*['"]([^'"]+)['"]/gi)) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(/\.add_url_rule\s*\(\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) found.push({ name: m[1].startsWith('/') ? m[1] : `/${m[1]}` })
      }
      for (const m of raw.matchAll(/^class\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*MethodView\s*\)/gm)) {
        if (m[1]) found.push({ name: `flask:${m[1]}`, alias: m[1] })
      }

      // Django path / re_path + include() namespace join (same-file nested + cross-file)
      for (const m of raw.matchAll(/\bpath\s*\(\s*['"]([^'"]+)['"]\s*,\s*include\s*\(/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(
        /\bpath\s*\(\s*['"]([^'"]+)['"]\s*,\s*include\s*\(\s*\[([\s\S]*?)\]\s*\)/g
      )) {
        const prefix = m[1] ?? ''
        const inner = m[2] ?? ''
        for (const innerPath of inner.matchAll(/\b(?:path|re_path)\s*\(\s*['"]([^'"]+)['"]/g)) {
          if (innerPath[1]) found.push({ name: djangoJoinPrefix(prefix, innerPath[1]) })
        }
      }
      const localPaths: string[] = []
      for (const m of raw.matchAll(/\b(?:path|re_path)\s*\(\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) {
          localPaths.push(m[1])
          found.push({ name: m[1] })
        }
      }
      // If this file is a urls module referenced by include('pkg.urls'), emit prefixed paths
      for (const [mod, prefixes] of djangoModulePrefixes) {
        const relPosixNorm = relPosix
        if (!djangoUrlsModuleFiles(mod).some(f => relPosixNorm === f || relPosixNorm.endsWith(`/${f}`))) {
          continue
        }
        for (const prefix of prefixes) {
          for (const seg of localPaths) {
            // Skip the include() lines themselves when this is a root urls with only includes
            if (raw.includes('include(') && seg === prefix) continue
            found.push({ name: djangoJoinPrefix(prefix, seg) })
          }
        }
      }
      // Django app_name — reverse-URL namespace (emit as coarse API surface)
      for (const m of raw.matchAll(/\bapp_name\s*=\s*['"]([a-z][a-z0-9_]*)['"]/g)) {
        if (m[1]) found.push({ name: `django-app/${m[1]}`, alias: m[1] })
      }
    }
    // Go gin/chi/echo/fiber + Go 1.22 ServeMux method patterns
    if (ext === '.go') {
      found.push(...goGroupPrefixRoutes(raw))
    }
    for (const m of raw.matchAll(
      /\b(?:r|router|mux|e|app)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle|Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g
    )) {
      const verb = (m[1] ?? 'GET').toUpperCase()
      const method = verb === 'ANY' || verb === 'HANDLE' ? 'ANY' : verb
      const routePath = m[2]
      if (routePath) found.push({ name: `${method} ${routePath}` })
    }
    for (const m of raw.matchAll(/\bhttp\.HandleFunc\s*\(\s*"([^"]+)"/g)) {
      if (m[1]) found.push({ name: m[1] })
    }
    // Go 1.22+: mux.Handle("GET /path", …) | HandleFunc("POST /path", …)
    for (const m of raw.matchAll(
      /\b(?:mux|http\.DefaultServeMux|\w+)\.(?:Handle|HandleFunc)\s*\(\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^"]*)"/g
    )) {
      if (m[1] && m[2]) found.push({ name: `${m[1]} ${m[2]}` })
    }
    // chi Mount / Route
    for (const m of raw.matchAll(/\b(?:r|router)\.(?:Mount|Route)\s*\(\s*"(\/[^"]*)"/g)) {
      if (m[1]) found.push({ name: m[1] })
    }

    // Spring MVC / WebFlux + JAX-RS + Micronaut + Ktor
    if (ext === '.java' || ext === '.kt' || ext === '.kts') {
      found.push(...springMappingPaths(raw))
      found.push(...micronautJoinedRoutes(raw))
      found.push(...jaxrsJoinedRoutes(raw))
      for (const m of raw.matchAll(/@Path\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      // Micronaut / Quarkus style @Get("/x") already covered by Spring-ish; Ktor:
      for (const m of raw.matchAll(
        /\b(?:get|post|put|patch|delete|head|options)\s*\(\s*"(\/[^"]*)"\s*\)/g
      )) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(/\broute\s*\(\s*"(\/[^"]*)"\s*\)\s*\{/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
    }

    // ASP.NET: [Route] [HttpGet] MapGet MapGroup
    if (ext === '.cs') {
      for (const m of raw.matchAll(/\[Route\s*\(\s*"([^"]+)"\s*\)\]/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(
        /\[Http(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"([^"]+)"\s*\)\]/g
      )) {
        if (m[1] && m[2]) found.push({ name: `${m[1].toUpperCase()} ${m[2]}` })
      }
      for (const m of raw.matchAll(
        /\.Map(Get|Post|Put|Patch|Delete|Methods|Group)\s*\(\s*"([^"]+)"/g
      )) {
        const method =
          m[1] === 'Methods' || m[1] === 'Group' ? 'ANY' : (m[1] ?? 'GET').toUpperCase()
        if (m[2]) found.push({ name: `${method} ${m[2]}` })
      }
    }

    // PHP Laravel / Symfony attributes / Slim maps
    if (ext === '.php') {
      for (const m of raw.matchAll(
        /\bRoute::(get|post|put|patch|delete|options|any|match|resource|apiResource)\s*\(\s*['"]([^'"]+)['"]/gi
      )) {
        const method = (m[1] ?? 'GET').toUpperCase()
        const routePath = m[2]
        if (!routePath) continue
        if (method === 'RESOURCE' || method === 'APIRESOURCE') {
          const base = routePath.startsWith('/') ? routePath : `/${routePath}`
          for (const r of expandRailsResourceRoutes(base.replace(/^\//, ''))) {
            // reuse CRUD expansion shape for Laravel resource routes
            found.push({ name: r.startsWith('/') || r.includes(' ') ? r : `/${r}` })
          }
        } else if (method === 'ANY' || method === 'MATCH') {
          found.push({ name: routePath })
        } else {
          found.push({ name: `${method} ${routePath}` })
        }
      }
      for (const m of raw.matchAll(/#\[Route\s*\(\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(/@Route\s*\(\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      // Slim: $app->get('/x', …) | $app->map(['GET','POST'], '/x', …)
      for (const m of raw.matchAll(
        /\$\w+->(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]/gi
      )) {
        const method = (m[1] ?? 'GET').toUpperCase()
        const routePath = m[2]
        if (!routePath) continue
        if (method === 'ANY') found.push({ name: routePath })
        else found.push({ name: `${method} ${routePath}` })
      }
      for (const m of raw.matchAll(
        /\$\w+->map\s*\(\s*\[([^\]]+)\]\s*,\s*['"]([^'"]+)['"]/g
      )) {
        const verbs = m[1] ?? ''
        const routePath = m[2]
        if (!routePath) continue
        for (const vm of verbs.matchAll(/['"](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"]/gi)) {
          if (vm[1]) found.push({ name: `${vm[1].toUpperCase()} ${routePath}` })
        }
      }
    }

    // Symfony YAML route files: `path: /api/users` (+ optional methods)
    if (ext === '.yaml' || ext === '.yml') {
      const looksRoutes =
        /(?:^|\/)routes[^/]*\.(ya?ml)$/i.test(relPosix) ||
        /(?:^|\/)config\/routes?\//i.test(relPosix) ||
        (/^\s*path\s*:\s*['"]?\//m.test(raw) &&
          (/^\s*controller\s*:/m.test(raw) || /^\s*methods\s*:/m.test(raw)))
      if (looksRoutes && !/^\s*openapi\s*:/m.test(raw) && !/^\s*swagger\s*:/m.test(raw)) {
        // Named route entries with path: /… and optional methods: [GET, POST]
        // Allow final property line without trailing newline.
        for (const m of raw.matchAll(
          /(^|\n)([A-Za-z_][\w.]*)\s*:\s*\n((?:[ \t]+.+(?:\n|$))*)/g
        )) {
          const block = m[3] ?? ''
          const pathMatch = block.match(/^\s*path\s*:\s*['"]?([^\s'"]+)['"]?/m)
          if (!pathMatch?.[1]?.startsWith('/')) continue
          const routePath = pathMatch[1]
          const methodsMatch = block.match(/^\s*methods\s*:\s*\[([^\]]+)\]/m)
          if (methodsMatch?.[1]) {
            for (const vm of methodsMatch[1].matchAll(
              /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/gi
            )) {
              if (vm[1]) found.push({ name: `${vm[1].toUpperCase()} ${routePath}` })
            }
          } else {
            found.push({ name: routePath })
          }
        }
        // Flat list style: `- path: /health`
        for (const m of raw.matchAll(/^\s*-\s*path\s*:\s*['"]?([^\s'"]+)['"]?/gm)) {
          if (m[1]?.startsWith('/')) found.push({ name: m[1] })
        }
      }
    }

    // Rust axum/actix/rocket
    if (ext === '.rs') {
      for (const m of raw.matchAll(
        /#\[(?:get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/gi
      )) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(
        /\.route\s*\(\s*"([^"]+)"\s*,\s*(?:get|post|put|patch|delete|any)\b/gi
      )) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(/web::resource\s*\(\s*"([^"]+)"\s*\)/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
    }

    // Scala http4s / Tapir / Play already handled via conf/routes
    if (ext === '.scala') {
      for (const m of raw.matchAll(/\b(?:HttpRoutes\.of|Router)\([^)]*["'](\/[^"']+)["']/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      // Tapir: endpoint.get.in("users") / .in("users" / path[Int])
      for (const m of raw.matchAll(/\.in\s*\(\s*"([A-Za-z0-9_-]+)"\s*\)/g)) {
        if (m[1]) found.push({ name: `/${m[1]}` })
      }
    }

    // Haskell Servant: "users" :> Get …  (multi-segment: "a" :> "b" :> Get)
    if (ext === '.hs' || ext === '.lhs') {
      for (const m of raw.matchAll(/"([A-Za-z0-9_-]+)"\s*:>\s*(Get|Post|Put|Patch|Delete)\b/g)) {
        if (m[1] && m[2]) found.push({ name: `${m[2].toUpperCase()} /${m[1]}` })
      }
      for (const m of raw.matchAll(
        /"([A-Za-z0-9_-]+)"\s*:>\s*"([A-Za-z0-9_-]+)"\s*:>\s*(Get|Post|Put|Patch|Delete)\b/g
      )) {
        if (m[1] && m[2] && m[3]) {
          found.push({ name: `${m[3].toUpperCase()} /${m[1]}/${m[2]}` })
        }
      }
    }

    // C++ Crow / Drogon
    if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.h' || ext === '.hpp') {
      for (const m of raw.matchAll(/CROW_ROUTE\s*\(\s*[^,]+,\s*"([^"]+)"\s*\)/g)) {
        if (m[1]) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(
        /ADD_METHOD_TO\s*\(\s*[^,]+,\s*"([^"]+)"\s*,\s*(?:Get|Post|Put|Patch|Delete)/g
      )) {
        if (m[1]) found.push({ name: m[1] })
      }
    }

    // Rails + Sinatra/Grape (routes.rb and *.rb)
    if (ext === '.rb') {
      if (relPosix.endsWith('routes.rb')) {
        // Nested namespace/scope + resources/verbs (covers flat resources too)
        found.push(...railsNestedRoutes(raw))
      }
      // Sinatra
      for (const m of raw.matchAll(
        /^\s*(?:get|post|put|patch|delete|options|head)\s+['"]([^'"]+)['"]/gm
      )) {
        if (m[1]) found.push({ name: m[1].startsWith('/') ? m[1] : `/${m[1]}` })
      }
      // Grape
      for (const m of raw.matchAll(/\b(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g)) {
        if (m[1]?.startsWith('/')) found.push({ name: m[1] })
      }
      for (const m of raw.matchAll(/\bresource\s+:([a-z][a-z0-9_]*)/g)) {
        if (m[1]) found.push({ name: `/${m[1]}` })
      }
    }

    // GraphQL root operation types as coarse API surfaces
    if (ext === '.graphql' || ext === '.gql') {
      for (const m of raw.matchAll(
        /^\s*(?:type|extend\s+type)\s+(Query|Mutation|Subscription)\s*[@{]/gm
      )) {
        if (m[1]) found.push({ name: `/graphql/${m[1]}` })
      }
    }

    for (const hit of found) {
      pushHit(hit.name, rel, hash, 'api', hit.alias)
    }
  }

  return { candidates, edges: [] }
}

/**
 * Tier-4 app-layer harvest: service/controller/handler classes → `module`,
 * ORM models / tables → `model`. Deterministic regex; low confidence; capped.
 * Deliberately does **not** use kind `service` (reserved for deployables).
 */
export async function harvestAppConcepts(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const seen = new Set<string>()
  const files = await walkFiles(scanDir, {
    extensions: APP_SOURCE_EXT,
    maxFiles: 2500,
  })
  // Also Prisma schema / SQL by basename walk already covered via extensions.

  let moduleCount = 0
  let modelCount = 0

  const pushModule = (
    name: string,
    rel: string,
    hash: string,
    gloss: string,
    aliases: string[] = [name]
  ) => {
    if (moduleCount >= APP_CONCEPT_CAP) return
    if (!isPlausibleTypeName(name)) return
    const before = candidates.length
    pushUniqueCandidate(candidates, seen, APP_CONCEPT_CAP + MODEL_CAP, {
      kind: 'module',
      canonicalName: name,
      aliases,
      gloss,
      sourceFile: rel,
      sourceKind: 'manifest',
      confidence: APP_CONCEPT_CONFIDENCE,
      contentHash: hash,
    })
    if (candidates.length > before) moduleCount += 1
  }

  const pushModel = (
    name: string,
    rel: string,
    hash: string,
    gloss: string,
    aliases: string[] = [name]
  ) => {
    if (modelCount >= MODEL_CAP) return
    if (!isPlausibleModelName(name)) return
    const before = candidates.length
    pushUniqueCandidate(candidates, seen, APP_CONCEPT_CAP + MODEL_CAP, {
      kind: 'model',
      canonicalName: name,
      aliases,
      gloss,
      sourceFile: rel,
      sourceKind: 'manifest',
      confidence: APP_CONCEPT_CONFIDENCE,
      contentHash: hash,
    })
    if (candidates.length > before) modelCount += 1
  }

  for (const filePath of files.sort()) {
    if (moduleCount >= APP_CONCEPT_CAP && modelCount >= MODEL_CAP) break
    const rel = path.relative(scanDir, filePath)
    const relPosix = rel.replace(/\\/g, '/')
    const ext = path.extname(relPosix).toLowerCase()
    const raw = await readText(filePath)
    if (!raw) continue
    const hash = sha256(raw)

    // --- Service / controller / handler classes (module) ---
    // Spring / Jakarta / Room
    if (ext === '.java' || ext === '.kt' || ext === '.kts') {
      for (const m of raw.matchAll(
        /@(?:Service|RestController|Controller|Repository|Component|Dao)\b[^\n]*\n(?:\s*@[^\n]+\n)*\s*(?:public\s+|internal\s+|open\s+)?(?:class|object)\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Spring/Jakarta application class')
      }
      for (const m of raw.matchAll(
        /@(?:Entity|Document)\b[^\n]*\n(?:\s*@[^\n]+\n)*\s*(?:public\s+|internal\s+)?(?:class|data\s+class)\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'JPA/Mongo/Room entity')
      }
      // Room: @Entity(tableName = "users")
      for (const m of raw.matchAll(
        /@Entity\s*\([^)]*tableName\s*=\s*["']([^"']+)["']/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Room tableName', [m[1]])
      }
      for (const m of raw.matchAll(/@Table\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'JPA @Table', [m[1]])
      }
      // Room @Database entities = [User::class, …] — class names already harvested via @Entity
    }

    // Nest / TS decorators + suffix heuristic + ORMs
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      for (const m of raw.matchAll(
        /@(?:Injectable|Controller|Catch|Resolver|Module)\b[^\n]*\n(?:\s*@[^\n]+\n)*\s*export\s+class\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'NestJS application class')
      }
      for (const m of raw.matchAll(
        /export\s+class\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|UseCase|Interactor|Resolver|Gateway|Store|Indexer|Registry|Pipeline|Orchestrator))\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Application layer class')
      }
      // Embedded SQL DDL in TS/JS source (node:sqlite migrations, etc.)
      for (const m of raw.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z_][\w]*["`]?\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'SQL table (embedded)')
      }
      for (const m of raw.matchAll(
        /@Entity\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)[^\n]*\n(?:\s*@[^\n]+\n)*\s*export\s+class\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        const table = m[1]
        const cls = m[2]
        if (cls) {
          pushModel(cls, rel, hash, 'TypeORM/MikroORM entity', table ? [cls, table] : [cls])
        }
      }
      // Sequelize
      for (const m of raw.matchAll(
        /\b(?:sequelize|Sequelize)\.define\s*\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Sequelize model')
      }
      for (const m of raw.matchAll(
        /export\s+class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+Model\b/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Sequelize Model subclass')
      }
      // Mongoose
      for (const m of raw.matchAll(
        /\bmongoose\.model\s*\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Mongoose model')
      }
      // Drizzle pgTable / mysqlTable / sqliteTable
      for (const m of raw.matchAll(
        /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Drizzle table')
      }
      for (const m of raw.matchAll(/\bmodel\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Prisma model')
      }
    }

    if (ext === '.prisma') {
      for (const m of raw.matchAll(/\bmodel\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Prisma model')
      }
      for (const m of raw.matchAll(/\benum\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Prisma enum')
      }
    }

    // Python Django/SQLAlchemy/Peewee/Tortoise/Pydantic + *Service + Flask MethodView
    if (ext === '.py') {
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Presenter|UseCase|Interactor|ViewSet|APIView))\s*[\(:]/gm
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Python application class')
      }
      for (const m of raw.matchAll(/^class\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*MethodView\s*\)/gm)) {
        if (m[1]) pushModule(m[1], rel, hash, 'Flask MethodView')
      }
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*(?:models\.Model|Base|db\.Model|SQLModel|Model|tortoise\.models\.Model)\s*\)/gm
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'ORM model class')
      }
      // Pydantic / SQLModel declarative (BaseModel) — treat as model when clearly schema
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*(?:BaseModel|SQLModel)\s*\)/gm
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Pydantic/SQLModel schema')
      }
      for (const m of raw.matchAll(/__tablename__\s*=\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'SQLAlchemy table', [m[1]])
      }
      // Peewee Meta.table_name
      for (const m of raw.matchAll(/table_name\s*=\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Peewee/ORM table_name', [m[1]])
      }
    }

    // Go handlers/services + GORM + ent
    if (ext === '.go') {
      for (const m of raw.matchAll(
        /\btype\s+([A-Z][A-Za-z0-9_]*(?:Service|Handler|Controller|Repository|Server|API|Usecase|UseCase))\s+struct\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Go application struct')
      }
      for (const m of raw.matchAll(
        /\btype\s+([A-Z][A-Za-z0-9_]*)\s+struct\s*\{[^}]*\bgorm\.(?:Model|DeletedAt)\b/gs
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'GORM model')
      }
      for (const m of raw.matchAll(
        /func\s+\(\s*[A-Za-z0-9_*]+\s+([A-Z][A-Za-z0-9_]*)\s*\)\s+TableName\s*\(/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'GORM TableName model')
      }
      for (const m of raw.matchAll(
        /func\s+\(([A-Z][A-Za-z0-9_]*)\)\s+Fields\s*\(\s*\)\s*\[\]ent\.Field/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'ent schema')
      }
    }

    // Ruby Rails
    if (ext === '.rb') {
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\s*<\s*(?:ApplicationController|ActionController::Base|ActionController::API)/gm
      )) {
        const name = m[1]?.split('::').pop()
        if (name) pushModule(name, rel, hash, 'Rails controller', m[1] ? [name, m[1]] : [name])
      }
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*(?:Service|Interactor|Worker|Job|Query|Command))\b/gm
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Rails application class')
      }
      for (const m of raw.matchAll(
        /^class\s+([A-Z][A-Za-z0-9_]*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/gm
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'ActiveRecord model')
      }
      for (const m of raw.matchAll(/self\.table_name\s*=\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'ActiveRecord table_name', [m[1]])
      }
    }

    // C# / ASP.NET / EF
    if (ext === '.cs') {
      for (const m of raw.matchAll(
        /(?:\[ApiController\]|\[Route\b)[\s\S]{0,200}?class\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'ASP.NET controller')
      }
      for (const m of raw.matchAll(
        /\b(?:class|record)\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|UseCase))\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, '.NET application class')
      }
      for (const m of raw.matchAll(
        /\[Table\s*\(\s*"([^"]+)"\s*\)\][\s\S]{0,120}?(?:class|record)\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[2]) pushModel(m[2], rel, hash, 'EF Core entity', m[1] ? [m[2], m[1]] : [m[2]])
      }
      for (const m of raw.matchAll(/\bDbSet<\s*([A-Z][A-Za-z0-9_]*)\s*>/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'EF Core DbSet')
      }
      for (const m of raw.matchAll(/\.ToTable\s*\(\s*"([^"]+)"\s*\)/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'EF Core ToTable', [m[1]])
      }
    }

    // PHP Laravel / Doctrine
    if (ext === '.php') {
      for (const m of raw.matchAll(
        /\bclass\s+([A-Z][A-Za-z0-9_]*(?:Controller|Service|Handler|Repository|Action|Job))\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'PHP application class')
      }
      for (const m of raw.matchAll(
        /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:Model|Authenticatable)\b/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Eloquent model')
      }
      if (/#\[ORM\\Entity\b|@ORM\\Entity\b/.test(raw)) {
        const cls = raw.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)\b/)
        if (cls?.[1]) pushModel(cls[1], rel, hash, 'Doctrine entity')
      }
      for (const m of raw.matchAll(/#\[ORM\\Table\s*\(\s*name:\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Doctrine table', [m[1]])
      }
      for (const m of raw.matchAll(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Eloquent $table', [m[1]])
      }
    }

    // Rust diesel / sea_orm / sqlx FromRow structs with table hints
    if (ext === '.rs') {
      for (const m of raw.matchAll(
        /\bstruct\s+([A-Z][A-Za-z0-9_]*(?:Service|Handler|Controller|Repo|Repository|UseCase))\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Rust application struct')
      }
      for (const m of raw.matchAll(
        /#\[derive\([^\]]*EntityModel[^\]]*\)\][\s\S]{0,80}?struct\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'SeaORM entity')
      }
      for (const m of raw.matchAll(/\btable!\s*\{\s*([a-z][a-z0-9_]*)\s*\(/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Diesel table')
      }
      for (const m of raw.matchAll(/#\[sea_orm\(table_name\s*=\s*"([^"]+)"\)\]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'SeaORM table_name', [m[1]])
      }
    }

    // Scala Slick / Quill-ish
    if (ext === '.scala') {
      for (const m of raw.matchAll(
        /\b(?:class|object)\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|Dao|DAO))\b/g
      )) {
        if (m[1]) pushModule(m[1], rel, hash, 'Scala application type')
      }
      for (const m of raw.matchAll(
        /\b(?:class|case class)\s+([A-Z][A-Za-z0-9_]*)\s*\([^\)]*\)\s*(?:extends|derives).*Entity/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Scala entity')
      }
      for (const m of raw.matchAll(/TableQuery\[\s*([A-Z][A-Za-z0-9_]*)\s*\]/g)) {
        if (m[1]) pushModel(m[1], rel, hash, 'Slick TableQuery')
      }
    }

    // Haskell Persistent: TH persist blocks + ModelName json lines
    if (ext === '.hs' || ext === '.lhs') {
      for (const m of raw.matchAll(
        /\[persist(?:LowerCase|UpperCase|With)?\|([\s\S]*?)\|\]/g
      )) {
        const block = m[1] ?? ''
        for (const line of block.split('\n')) {
          // Model declarations sit at column 0; fields are indented.
          const modelLine = line.match(/^([A-Z][A-Za-z0-9_]*)(?:\s+json)?\s*$/)
          if (modelLine?.[1] && isPlausibleTypeName(modelLine[1])) {
            pushModel(modelLine[1], rel, hash, 'Persistent model (TH block)')
          }
        }
      }
      for (const m of raw.matchAll(/^([A-Z][A-Za-z0-9_]*)\s+json(\s|$)/gm)) {
        if (m[1] && isPlausibleTypeName(m[1])) {
          pushModel(m[1], rel, hash, 'Persistent model (quasi-quote line)')
        }
      }
    }

    // Hibernate XML mappings (*.hbm.xml / orm.xml / hibernate *.xml)
    if (ext === '.xml') {
      const looksHibernate =
        /\.hbm\.xml$/i.test(relPosix) ||
        /(?:^|\/)orm\.xml$/i.test(relPosix) ||
        /<hibernate-mapping\b/i.test(raw) ||
        /<entity-mappings\b/i.test(raw) ||
        /xmlns\s*=\s*["'][^"']*hibernate/i.test(raw)
      if (looksHibernate) {
        for (const m of raw.matchAll(
          /<class\s+[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\btable\s*=\s*["']([^"']+)["']/gi
        )) {
          const cls = m[1]?.split('.').pop()
          if (cls) pushModel(cls, rel, hash, 'Hibernate class', m[2] ? [cls, m[2]] : [cls])
          if (m[2]) pushModel(m[2], rel, hash, 'Hibernate table', [m[2]])
        }
        for (const m of raw.matchAll(
          /<class\s+[^>]*\btable\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']([^"']+)["']/gi
        )) {
          const cls = m[2]?.split('.').pop()
          if (cls) pushModel(cls, rel, hash, 'Hibernate class', m[1] ? [cls, m[1]] : [cls])
          if (m[1]) pushModel(m[1], rel, hash, 'Hibernate table', [m[1]])
        }
        for (const m of raw.matchAll(/<entity\s+[^>]*\bclass\s*=\s*["']([^"']+)["']/gi)) {
          const cls = m[1]?.split('.').pop()
          if (cls) pushModel(cls, rel, hash, 'JPA orm.xml entity')
        }
        for (const m of raw.matchAll(/<table\s+[^>]*\bname\s*=\s*["']([^"']+)["']/gi)) {
          if (m[1]) pushModel(m[1], rel, hash, 'JPA orm.xml table', [m[1]])
        }
      }
    }

    // Kotlin Exposed
    if (ext === '.kt' || ext === '.kts') {
      for (const m of raw.matchAll(
        /\bobject\s+([A-Z][A-Za-z0-9_]*)\s*:\s*Table\s*\(\s*"([^"]+)"\s*\)/g
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'Exposed Table', m[2] ? [m[1], m[2]] : [m[1]])
      }
    }

    // GraphQL object types as models (not Query/Mutation roots)
    if (ext === '.graphql' || ext === '.gql') {
      for (const m of raw.matchAll(/^\s*type\s+([A-Z][A-Za-z0-9_]*)\s*[@{]/gm)) {
        const name = m[1]
        if (
          name &&
          name !== 'Query' &&
          name !== 'Mutation' &&
          name !== 'Subscription' &&
          isPlausibleTypeName(name)
        ) {
          pushModel(name, rel, hash, 'GraphQL type')
        }
      }
    }

    // SQL DDL (.sql files; TS/JS embedded DDL handled above)
    if (ext === '.sql') {
      for (const m of raw.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z_][\w]*["`]?\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'SQL table')
      }
    }

    // Embedded CREATE TABLE in other languages (Go embed, Python strings, etc.)
    if (
      ['.py', '.go', '.java', '.kt', '.kts', '.rb', '.cs', '.php', '.rs'].includes(ext) &&
      /\bCREATE\s+TABLE\b/i.test(raw)
    ) {
      for (const m of raw.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z_][\w]*["`]?\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi
      )) {
        if (m[1]) pushModel(m[1], rel, hash, 'SQL table (embedded)')
      }
    }
  }

  return { candidates, edges: [] }
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

  const deps = [...tomlTableKeys(raw, 'dependencies'), ...tomlTableKeys(raw, 'dev-dependencies')]
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
    parsed.bin &&
      (typeof parsed.bin === 'string' || (Array.isArray(parsed.bin) && parsed.bin.length > 0))
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
    const { kind, confidence } = classifyFromSignals(
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
      confidence,
      contentHash: sha256(raw),
    })
  }

  // Gemfile-only app root (typical Rails) when no gemspec provides identity.
  if (candidates.length === 0 && gemfileRaw) {
    const name = path.basename(scanDir)
    const { kind, confidence } = classifyFromSignals({ deps: gemfileDeps }, config)
    candidates.push({
      kind,
      canonicalName: name,
      aliases: [name],
      sourceFile: 'Gemfile',
      sourceKind: 'manifest',
      confidence,
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
  const { kind, confidence } = classifyFromSignals({ deps, packageName: artifactId }, config)
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
      confidence,
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
        const { kind, confidence } = classifyFromSignals({ deps, packageName: name }, config)
        candidates.push({
          kind,
          canonicalName: name,
          aliases: [name, `:${member.replace(/\//g, ':')}`],
          sourceFile: buildRel,
          sourceKind: 'manifest',
          confidence,
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
    const { kind, confidence } = classifyFromSignals(
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
          confidence,
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
  const { kind, confidence } = classifyFromSignals(
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
        confidence,
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
  const { kind, confidence } = classifyFromSignals({ deps, packageName: name }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name, path.basename(scanDir)],
        sourceFile: 'CMakeLists.txt',
        sourceKind: 'manifest',
        confidence,
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
    const { kind, confidence } = classifyFromSignals(
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
      confidence,
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
  const { kind, confidence } = classifyFromSignals({ deps, packageName: name }, config)
  return {
    candidates: [
      {
        kind,
        canonicalName: name,
        aliases: [name, path.basename(scanDir)],
        sourceFile: 'build.sbt',
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
