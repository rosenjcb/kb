/**
 * Load per-ecosystem harvester YAML from `tools/ecosystems/`.
 *
 * - tsx / tests: `src/tools/ecosystems/*.yaml`
 * - bundled CLI/server: `dist/bin/ecosystems/*.yaml` (copied by copyCliRuntimeAssets)
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import type { EntityKind } from './entity-registry.js'

export type CoverageStatus =
  | 'implemented'
  | 'partial'
  | 'not_implemented'
  | 'not_applicable'
  | 'planned'

export interface KindRuleMatch {
  any_dependency_group?: string
  any_dependency?: string[]
  without_dependency_group?: string
  any_script?: string[]
  has_bin?: boolean
  without_bin?: boolean
  has_entry?: boolean
  has_scripts_entry?: boolean
  has_bin_target?: boolean
  has_lib_target?: boolean
  without_bin_target?: boolean
  composer_type?: string
  output_type?: string
  has_executable_stanza?: boolean
  has_library_stanza?: boolean
  /** Project Sdk attribute values (C# / .NET). */
  any_sdk?: string[]
  /** Unscoped package name ends with this suffix (e.g. `-server`, `server`). */
  name_ends_with?: string
  /** Any bin key ends with this suffix (e.g. `-server`). */
  bin_name_ends_with?: string
}

export interface KindRule {
  kind: EntityKind
  match: KindRuleMatch
}

export interface CoverageSection {
  status: CoverageStatus
  note?: string
  planned?: string[]
  planned_frameworks?: string[]
}

/** Named pattern-engine strategies (tier-4 / contracts). Unknown ids fail load. */
export const PATTERN_STRATEGIES = [
  'regex',
  'class_method_prefix_join',
  'router_group_prefix_join',
  'rails_resources_crud',
  'django_include_join',
  'openapi_path_items',
  'prisma_schema_blocks',
  'next_filesystem_routes',
  'trpc_procedures',
  'symfony_yaml_routes',
  'embedded_sql_ddl',
] as const

export type PatternStrategy = (typeof PATTERN_STRATEGIES)[number]

export const PATTERN_FILTERS = [
  'plausible_http_route',
  'plausible_type_name',
  'plausible_model_name',
  'none',
] as const

export type PatternFilter = (typeof PATTERN_FILTERS)[number]

export type PatternPhase = 'routes' | 'app' | 'contracts'

/** One executable harvest rule from ecosystem YAML `source_patterns`. */
export interface SourcePattern {
  id: string
  kind: EntityKind
  gloss?: string
  filter: PatternFilter
  strategy: PatternStrategy
  /** Which harvest entrypoint runs this rule. Default from `kind`. */
  phase: PatternPhase
  files: {
    extensions?: string[]
    basenames?: string[]
    /** Match when repo-relative path ends with one of these (posix). */
    path_suffixes?: string[]
  }
  /** `regex` strategy: JS regex source. */
  pattern?: string
  flags?: string
  name_group?: number
  name_template?: string
  alias_groups?: number[]
  /** Named join algorithm inside a strategy family (nest, spring, fastapi, …). */
  join_style?: string
  skip_names?: string[]
  require_leading_slash?: boolean
  /** Special regex post-processors (persistent_th, …). */
  name_from?: string
  map_verbs_group?: number
  path_group?: number
  emit_extra_group_as_model?: number
  /** Compiled at load for `regex` strategy. */
  compiledRegex?: RegExp
}

/** Shared shape for language package ecosystems (typescript, go, python, …). */
export interface PackageEcosystemConfig {
  id: string
  display_name: string
  status: CoverageStatus
  frameworks: Record<string, string[]>
  kind_rules: KindRule[]
  symbols: CoverageSection
  routes: CoverageSection
  /** App-layer classes (Spring @Service, Nest Injectable, …) → `module`. */
  app_classes?: CoverageSection
  /** ORM / schema models → `model`. */
  models?: CoverageSection
  /** Executable tier-4 / source harvest rules. */
  source_patterns: SourcePattern[]
  /** TypeScript-only convenience (root package.json name). */
  package_manifest?: string
  workspace?: {
    sources: Array<{
      path: string
      packages_key?: string
      workspaces_key?: string
    }>
  }
}

/** Cross-language patterns from `common.yaml` (not a package ecosystem). */
export interface CommonEcosystemConfig {
  id: 'common'
  display_name: string
  status: CoverageStatus
  source_patterns: SourcePattern[]
}

export type TypescriptEcosystemConfig = PackageEcosystemConfig & {
  id: 'typescript'
  package_manifest: string
  workspace: NonNullable<PackageEcosystemConfig['workspace']>
}

export interface InfraEcosystemConfig {
  id: 'infra'
  display_name: string
  compose: {
    files: string[]
    services_key: string
    kind: EntityKind
  }
  fly: {
    file: string
    app_pattern: string
    kind: EntityKind
  }
  backstage: {
    file: string
    kind_map: Record<string, EntityKind | string> & { default: EntityKind | string }
    belongs_to_keys: string[]
    owned_by_keys?: string[]
  }
  kubernetes: {
    dirs: string[]
    kinds: string[]
    kind_map: Record<string, EntityKind | string> & { default: EntityKind | string }
    skip_template_marker: string
  }
  helm: {
    file: string
    name_key: string
    kind: EntityKind
  }
  procfile: {
    file: string
    kind: EntityKind
  }
  symbols: CoverageSection
  routes: CoverageSection
}

const ENTITY_KINDS = new Set<EntityKind>([
  'domain',
  'team',
  'service',
  'surface',
  'repo',
  'module',
  'api',
  'library',
  'cli',
  'model',
])

/** Ecosystems with harvest inference wired in ecosystem-harvesters.ts. */
export const IMPLEMENTED_PACKAGE_ECOSYSTEMS = [
  'typescript',
  'go',
  'python',
  'rust',
  'php',
  'ruby',
  'java',
  'haskell',
  'cpp',
  'csharp',
  'scala',
] as const

const ecosystemsRootDir = join(dirname(fileURLToPath(import.meta.url)), 'ecosystems')

const packageCache = new Map<string, PackageEcosystemConfig>()
let infraCache: InfraEcosystemConfig | null = null
let commonCache: CommonEcosystemConfig | null = null
let allPatternsCache: SourcePattern[] | null = null

const STRATEGY_SET = new Set<string>(PATTERN_STRATEGIES)
const FILTER_SET = new Set<string>(PATTERN_FILTERS)

function resolveEcosystemPath(id: string): string {
  return join(ecosystemsRootDir, `${id}.yaml`)
}

function defaultPhaseForKind(kind: EntityKind): PatternPhase {
  if (kind === 'module' || kind === 'model') return 'app'
  return 'routes'
}

/**
 * Harvest rules describe *what* a manifest or pattern declares — never how much
 * to trust it. A hand-typed `confidence` is an unfalsifiable guess: nobody can
 * demonstrate 0.6 is wrong, so it never gets corrected, and any retrieval stage
 * that reads it silently bakes the guess into every experiment downstream. If a
 * rule's evidence is too weak to act on, delete the rule instead of discounting it.
 */
function rejectHandAssignedWeight(obj: Record<string, unknown>, context: string): void {
  for (const key of ['confidence', 'weight', 'score'] as const) {
    if (obj[key] !== undefined) {
      throw new Error(
        `${context} sets "${key}" — harvest rules must not carry hand-assigned weights. Drop the key; if the signal is too weak to trust, remove the rule.`
      )
    }
  }
}

/** Validate one source_pattern object (tests and loaders). */
export function parseSourcePattern(raw: unknown, context = 'source_pattern'): SourcePattern {
  return asSourcePattern(raw, context)
}

function asSourcePattern(raw: unknown, context: string): SourcePattern {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid source_pattern in ${context}`)
  }
  const obj = raw as Record<string, unknown>
  const id = String(obj.id ?? '')
  if (!id) throw new Error(`source_pattern missing id in ${context}`)
  rejectHandAssignedWeight(obj, `${context}(${id})`)
  const kind = asKind(obj.kind, `${context}(${id}).kind`)
  const strategyRaw = obj.strategy === undefined ? 'regex' : String(obj.strategy)
  if (!STRATEGY_SET.has(strategyRaw)) {
    throw new Error(`Unknown strategy "${strategyRaw}" in ${context}(${id})`)
  }
  const strategy = strategyRaw as PatternStrategy
  const filterRaw = obj.filter === undefined ? 'none' : String(obj.filter)
  if (!FILTER_SET.has(filterRaw)) {
    throw new Error(`Unknown filter "${filterRaw}" in ${context}(${id})`)
  }
  const filesRaw = (obj.files ?? {}) as Record<string, unknown>
  const files: SourcePattern['files'] = {
    ...(Array.isArray(filesRaw.extensions) ? { extensions: filesRaw.extensions.map(String) } : {}),
    ...(Array.isArray(filesRaw.basenames) ? { basenames: filesRaw.basenames.map(String) } : {}),
    ...(Array.isArray(filesRaw.path_suffixes)
      ? { path_suffixes: filesRaw.path_suffixes.map(String) }
      : {}),
  }
  const phaseRaw = obj.phase
  const phase: PatternPhase =
    phaseRaw === 'routes' || phaseRaw === 'app' || phaseRaw === 'contracts'
      ? phaseRaw
      : defaultPhaseForKind(kind)

  const pattern: SourcePattern = {
    id,
    kind,
    filter: filterRaw as PatternFilter,
    strategy,
    phase,
    files,
    ...(typeof obj.gloss === 'string' ? { gloss: obj.gloss } : {}),
    ...(typeof obj.pattern === 'string' ? { pattern: obj.pattern } : {}),
    ...(typeof obj.flags === 'string' ? { flags: obj.flags } : {}),
    ...(obj.name_group !== undefined ? { name_group: Number(obj.name_group) } : {}),
    ...(typeof obj.name_template === 'string' ? { name_template: obj.name_template } : {}),
    ...(Array.isArray(obj.alias_groups)
      ? { alias_groups: obj.alias_groups.map(n => Number(n)) }
      : {}),
    ...(typeof obj.join_style === 'string' ? { join_style: obj.join_style } : {}),
    ...(Array.isArray(obj.skip_names) ? { skip_names: obj.skip_names.map(String) } : {}),
    ...(obj.require_leading_slash === true ? { require_leading_slash: true } : {}),
    ...(typeof obj.name_from === 'string' ? { name_from: obj.name_from } : {}),
    ...(obj.map_verbs_group !== undefined ? { map_verbs_group: Number(obj.map_verbs_group) } : {}),
    ...(obj.path_group !== undefined ? { path_group: Number(obj.path_group) } : {}),
    ...(obj.emit_extra_group_as_model !== undefined
      ? { emit_extra_group_as_model: Number(obj.emit_extra_group_as_model) }
      : {}),
  }

  if (strategy === 'regex') {
    if (pattern.name_from === 'persistent_th') {
      // Body parsed inside the strategy runner; still need the outer match regex.
    }
    if (!pattern.pattern && pattern.name_from !== 'persistent_th') {
      // persistent_th still has pattern in YAML
    }
    if (!pattern.pattern) {
      throw new Error(`regex strategy requires pattern in ${context}(${id})`)
    }
    try {
      pattern.compiledRegex = new RegExp(pattern.pattern, pattern.flags ?? 'g')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid regex in ${context}(${id}): ${msg}`)
    }
  }
  return pattern
}

function parseSourcePatterns(raw: unknown, context: string): SourcePattern[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error(`${context} source_patterns must be a list`)
  }
  return raw.map((item, i) => asSourcePattern(item, `${context}.source_patterns[${i}]`))
}

function readEcosystemYaml(id: string): unknown {
  const filePath = resolveEcosystemPath(id)
  try {
    return loadYaml(readFileSync(filePath, 'utf8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to load ecosystem config ${filePath}: ${msg}`)
  }
}

function asKind(value: unknown, context: string): EntityKind {
  if (typeof value !== 'string' || !ENTITY_KINDS.has(value as EntityKind)) {
    throw new Error(`Invalid entity kind in ${context}: ${String(value)}`)
  }
  return value as EntityKind
}

function asCoverage(raw: unknown, context: string): CoverageSection {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Missing coverage section ${context}`)
  }
  const obj = raw as Record<string, unknown>
  const status = obj.status
  if (
    status !== 'implemented' &&
    status !== 'partial' &&
    status !== 'not_implemented' &&
    status !== 'not_applicable' &&
    status !== 'planned'
  ) {
    throw new Error(`Invalid coverage status in ${context}: ${String(status)}`)
  }
  return {
    status,
    ...(typeof obj.note === 'string' ? { note: obj.note } : {}),
    ...(Array.isArray(obj.planned) ? { planned: obj.planned.map(String) } : {}),
    ...(Array.isArray(obj.planned_frameworks)
      ? { planned_frameworks: obj.planned_frameworks.map(String) }
      : {}),
  }
}

function asCoverageStatus(value: unknown, fallback: CoverageStatus = 'planned'): CoverageStatus {
  if (
    value === 'implemented' ||
    value === 'partial' ||
    value === 'not_implemented' ||
    value === 'not_applicable' ||
    value === 'planned'
  ) {
    return value
  }
  return fallback
}

/** Absolute dir for ecosystem YAML assets (src or dist/bin sibling). */
export function ecosystemsConfigDir(): string {
  return ecosystemsRootDir
}

/** List ecosystem YAML ids (excluding research/, README, and common.yaml). */
export function listEcosystemIds(): string[] {
  return readdirSync(ecosystemsRootDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => f.replace(/\.ya?ml$/, ''))
    .filter(id => id !== 'common')
    .sort()
}

export function loadPackageEcosystemConfig(id: string): PackageEcosystemConfig {
  const cached = packageCache.get(id)
  if (cached) return cached
  const raw = readEcosystemYaml(id) as Record<string, unknown>
  if (String(raw.id) !== id) {
    throw new Error(`Expected id: ${id} in ${id}.yaml, got ${String(raw.id)}`)
  }
  if (!raw.frameworks || typeof raw.frameworks !== 'object') {
    throw new Error(`${id}.yaml missing frameworks map`)
  }

  const frameworks: Record<string, string[]> = {}
  for (const [group, names] of Object.entries(raw.frameworks as Record<string, unknown>)) {
    if (!Array.isArray(names)) {
      throw new Error(`${id}.yaml frameworks.${group} must be a string list`)
    }
    frameworks[group] = names.map(String)
  }

  const kind_rules: KindRule[] = Array.isArray(raw.kind_rules)
    ? raw.kind_rules.map((rule, i) => {
        const r = rule as Record<string, unknown>
        rejectHandAssignedWeight(r, `${id}.kind_rules[${i}]`)
        const match = (r.match ?? {}) as KindRuleMatch
        return {
          kind: asKind(r.kind, `${id}.kind_rules[${i}]`),
          match,
        }
      })
    : []

  const defaultGap: CoverageSection = {
    status: 'not_implemented',
    note: 'Not declared in ecosystem YAML.',
  }
  const config: PackageEcosystemConfig = {
    id,
    display_name: String(raw.display_name ?? id),
    status: asCoverageStatus(raw.status, 'planned'),
    frameworks,
    kind_rules,
    symbols: asCoverage(raw.symbols, `${id}.symbols`),
    routes: asCoverage(raw.routes, `${id}.routes`),
    app_classes: raw.app_classes ? asCoverage(raw.app_classes, `${id}.app_classes`) : defaultGap,
    models: raw.models ? asCoverage(raw.models, `${id}.models`) : defaultGap,
    source_patterns: parseSourcePatterns(raw.source_patterns, id),
    ...(typeof raw.package_manifest === 'string' ? { package_manifest: raw.package_manifest } : {}),
    ...(raw.workspace ? { workspace: raw.workspace as PackageEcosystemConfig['workspace'] } : {}),
  }
  packageCache.set(id, config)
  return config
}

export function loadCommonEcosystemConfig(): CommonEcosystemConfig {
  if (commonCache) return commonCache
  const raw = readEcosystemYaml('common') as Record<string, unknown>
  if (String(raw.id) !== 'common') {
    throw new Error(`Expected id: common in common.yaml, got ${String(raw.id)}`)
  }
  commonCache = {
    id: 'common',
    display_name: String(raw.display_name ?? 'Cross-language source patterns'),
    status: asCoverageStatus(raw.status, 'implemented'),
    source_patterns: parseSourcePatterns(raw.source_patterns, 'common'),
  }
  return commonCache
}

/** All executable source patterns: common.yaml + every package ecosystem. */
export function loadAllSourcePatterns(): SourcePattern[] {
  if (allPatternsCache) return allPatternsCache
  const patterns: SourcePattern[] = [...loadCommonEcosystemConfig().source_patterns]
  for (const id of IMPLEMENTED_PACKAGE_ECOSYSTEMS) {
    patterns.push(...loadPackageEcosystemConfig(id).source_patterns)
  }
  allPatternsCache = patterns
  return patterns
}

export function loadTypescriptEcosystemConfig(): TypescriptEcosystemConfig {
  const config = loadPackageEcosystemConfig('typescript')
  if (!config.package_manifest || !config.workspace?.sources?.length) {
    throw new Error('typescript.yaml missing package_manifest / workspace.sources')
  }
  return config as TypescriptEcosystemConfig
}

export function loadInfraEcosystemConfig(): InfraEcosystemConfig {
  if (infraCache) return infraCache
  const raw = readEcosystemYaml('infra') as Record<string, unknown>
  if (raw.id !== 'infra') {
    throw new Error(`Expected id: infra in infra.yaml, got ${String(raw.id)}`)
  }

  const compose = raw.compose as InfraEcosystemConfig['compose']
  const fly = raw.fly as InfraEcosystemConfig['fly']
  const backstage = raw.backstage as InfraEcosystemConfig['backstage']
  const kubernetes = raw.kubernetes as InfraEcosystemConfig['kubernetes']
  const helm = raw.helm as InfraEcosystemConfig['helm']
  const procfile = raw.procfile as InfraEcosystemConfig['procfile']
  if (!compose?.files?.length || !fly?.file || !backstage?.file) {
    throw new Error('infra.yaml missing compose/fly/backstage sections')
  }
  if (!kubernetes?.dirs?.length || !kubernetes.kinds?.length || !helm?.file || !procfile?.file) {
    throw new Error('infra.yaml missing kubernetes/helm/procfile sections')
  }

  infraCache = {
    id: 'infra',
    display_name: String(raw.display_name ?? 'Deploy / infra manifests'),
    compose: {
      ...compose,
      kind: asKind(compose.kind, 'infra.compose.kind'),
    },
    fly: {
      ...fly,
      kind: asKind(fly.kind, 'infra.fly.kind'),
    },
    backstage: {
      ...backstage,
      kind_map: {
        ...backstage.kind_map,
        default: asKind(backstage.kind_map.default, 'infra.backstage.kind_map.default'),
      },
    },
    kubernetes: {
      ...kubernetes,
      skip_template_marker: String(kubernetes.skip_template_marker ?? '{{'),
      kind_map: {
        ...kubernetes.kind_map,
        default: asKind(kubernetes.kind_map.default, 'infra.kubernetes.kind_map.default'),
      },
    },
    helm: {
      ...helm,
      name_key: String(helm.name_key ?? 'name'),
      kind: asKind(helm.kind, 'infra.helm.kind'),
    },
    procfile: {
      ...procfile,
      kind: asKind(procfile.kind, 'infra.procfile.kind'),
    },
    symbols: asCoverage(raw.symbols, 'infra.symbols'),
    routes: asCoverage(raw.routes, 'infra.routes'),
  }
  return infraCache
}

/** Test helper — drop cached YAML so a rewrite is visible. */
export function resetEcosystemConfigCache(): void {
  packageCache.clear()
  infraCache = null
  commonCache = null
  allPatternsCache = null
}
