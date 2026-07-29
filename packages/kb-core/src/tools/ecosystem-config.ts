/**
 * Load per-ecosystem harvester YAML from `tools/ecosystems/`.
 *
 * - tsx / tests: `src/tools/ecosystems/*.yaml`
 * - bundled CLI/server: `dist/bin/ecosystems/*.yaml` (copied by copyCliRuntimeAssets)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import type { EntityKind } from './entity-registry.js'

export type CoverageStatus = 'implemented' | 'not_implemented' | 'not_applicable' | 'planned'

export interface KindRuleMatch {
  any_dependency_group?: string
  any_script?: string[]
  has_bin?: boolean
  without_bin?: boolean
  has_entry?: boolean
}

export interface KindRule {
  kind: EntityKind
  confidence: number
  match: KindRuleMatch
}

export interface CoverageSection {
  status: CoverageStatus
  note?: string
  planned?: string[]
  planned_frameworks?: string[]
}

export interface TypescriptEcosystemConfig {
  id: 'typescript'
  display_name: string
  package_manifest: string
  workspace: {
    sources: Array<{
      path: string
      packages_key?: string
      workspaces_key?: string
    }>
  }
  frameworks: Record<string, string[]>
  kind_rules: KindRule[]
  symbols: CoverageSection
  routes: CoverageSection
}

export interface InfraEcosystemConfig {
  id: 'infra'
  display_name: string
  compose: {
    files: string[]
    services_key: string
    kind: EntityKind
    confidence: number
  }
  fly: {
    file: string
    app_pattern: string
    kind: EntityKind
    confidence: number
  }
  backstage: {
    file: string
    kind_map: Record<string, EntityKind | string> & { default: EntityKind | string }
    confidence: number
    belongs_to_keys: string[]
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
])

const ecosystemsRootDir = join(dirname(fileURLToPath(import.meta.url)), 'ecosystems')

let typescriptCache: TypescriptEcosystemConfig | null = null
let infraCache: InfraEcosystemConfig | null = null

function resolveEcosystemPath(id: string): string {
  return join(ecosystemsRootDir, `${id}.yaml`)
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

/** Absolute dir for ecosystem YAML assets (src or dist/bin sibling). */
export function ecosystemsConfigDir(): string {
  return ecosystemsRootDir
}

export function loadTypescriptEcosystemConfig(): TypescriptEcosystemConfig {
  if (typescriptCache) return typescriptCache
  const raw = readEcosystemYaml('typescript') as Record<string, unknown>
  if (raw.id !== 'typescript') {
    throw new Error(`Expected id: typescript in typescript.yaml, got ${String(raw.id)}`)
  }
  if (!raw.frameworks || typeof raw.frameworks !== 'object') {
    throw new Error('typescript.yaml missing frameworks map')
  }
  if (!Array.isArray(raw.kind_rules) || raw.kind_rules.length === 0) {
    throw new Error('typescript.yaml missing kind_rules')
  }

  const frameworks: Record<string, string[]> = {}
  for (const [group, names] of Object.entries(raw.frameworks as Record<string, unknown>)) {
    if (!Array.isArray(names)) {
      throw new Error(`typescript.yaml frameworks.${group} must be a string list`)
    }
    frameworks[group] = names.map(String)
  }

  const kind_rules: KindRule[] = raw.kind_rules.map((rule, i) => {
    const r = rule as Record<string, unknown>
    const match = (r.match ?? {}) as KindRuleMatch
    return {
      kind: asKind(r.kind, `kind_rules[${i}]`),
      confidence: Number(r.confidence),
      match,
    }
  })

  const workspace = raw.workspace as TypescriptEcosystemConfig['workspace']
  if (!workspace?.sources?.length) {
    throw new Error('typescript.yaml missing workspace.sources')
  }

  typescriptCache = {
    id: 'typescript',
    display_name: String(raw.display_name ?? 'TypeScript / JavaScript'),
    package_manifest: String(raw.package_manifest ?? 'package.json'),
    workspace,
    frameworks,
    kind_rules,
    symbols: asCoverage(raw.symbols, 'typescript.symbols'),
    routes: asCoverage(raw.routes, 'typescript.routes'),
  }
  return typescriptCache
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
  if (!compose?.files?.length || !fly?.file || !backstage?.file) {
    throw new Error('infra.yaml missing compose/fly/backstage sections')
  }

  infraCache = {
    id: 'infra',
    display_name: String(raw.display_name ?? 'Deploy / infra manifests'),
    compose: {
      ...compose,
      kind: asKind(compose.kind, 'infra.compose.kind'),
      confidence: Number(compose.confidence),
    },
    fly: {
      ...fly,
      kind: asKind(fly.kind, 'infra.fly.kind'),
      confidence: Number(fly.confidence),
    },
    backstage: {
      ...backstage,
      confidence: Number(backstage.confidence),
      kind_map: {
        ...backstage.kind_map,
        default: asKind(backstage.kind_map.default, 'infra.backstage.kind_map.default'),
      },
    },
    symbols: asCoverage(raw.symbols, 'infra.symbols'),
    routes: asCoverage(raw.routes, 'infra.routes'),
  }
  return infraCache
}

/** Test helper — drop cached YAML so a rewrite is visible. */
export function resetEcosystemConfigCache(): void {
  typescriptCache = null
  infraCache = null
}
