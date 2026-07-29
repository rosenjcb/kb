/**
 * JavaScript / TypeScript ecosystem harvester.
 *
 * Workspace topology → per-package identity → deterministic kind rubric. The
 * rubric is a decision table, never an LLM: ambiguity lowers confidence instead
 * of guessing harder.
 */

import path from 'node:path'
import {
  findManifests,
  hashContent,
  manifestDirName,
  parseJsonSafe,
  parseYamlSafe,
  readTextFile,
} from './fs-utils.js'
import type { CandidateEdge, EcosystemHarvester, EntityCandidate, HarvestResult } from './types.js'
import type { EntityKind } from '../entity-registry.js'

const ECOSYSTEM = 'javascript'

export interface PackageJson {
  name?: string
  description?: string
  bin?: string | Record<string, string>
  main?: string
  exports?: unknown
  private?: boolean
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

/** Unscoped variant of an npm package name (`@acme/payments` → `payments`). */
export function unscoped(name: string): string {
  return name.startsWith('@') ? (name.split('/')[1] ?? name) : name
}

export function classifyPackageKind(pkg: PackageJson): { kind: EntityKind; confidence: number } {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const hasDep = (names: string[]) => names.some(n => n in deps)
  const hasBin = Boolean(pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0))
  const hasStart = Boolean(pkg.scripts?.start || pkg.scripts?.serve)

  if (hasDep(SERVER_FRAMEWORKS) || (hasStart && !hasBin)) {
    return { kind: 'service', confidence: hasDep(SERVER_FRAMEWORKS) ? 0.9 : 0.6 }
  }
  if (hasBin) return { kind: 'cli', confidence: 0.85 }
  if (hasDep(FRONTEND_FRAMEWORKS)) return { kind: 'surface', confidence: 0.75 }
  if (hasDep(CLI_FRAMEWORKS)) return { kind: 'cli', confidence: 0.6 }
  if (pkg.main || pkg.exports) return { kind: 'library', confidence: 0.8 }
  return { kind: 'library', confidence: 0.4 }
}

/** Workspace member manifests declared by pnpm-workspace.yaml or package.json `workspaces`. */
async function workspacePackageManifests(scanDir: string): Promise<string[]> {
  const globs: string[] = []

  const pnpmWs = await readTextFile(scanDir, 'pnpm-workspace.yaml')
  if (pnpmWs) {
    const parsed = parseYamlSafe<{ packages?: string[] }>(pnpmWs)
    if (parsed?.packages) globs.push(...parsed.packages)
  }

  const rootRaw = await readTextFile(scanDir, 'package.json')
  const rootPkg = rootRaw ? parseJsonSafe<PackageJson>(rootRaw) : null
  if (rootPkg?.workspaces) {
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages
    if (ws) globs.push(...ws)
  }
  if (globs.length === 0) return []

  // Workspace globs address directories; manifests are one level inside them.
  // Negations are honored by fast-glob when passed through as-is.
  const patterns = globs.map(glob =>
    glob.startsWith('!')
      ? `!${path.posix.join(glob.slice(1), 'package.json')}`
      : path.posix.join(glob, 'package.json')
  )
  return findManifests(scanDir, patterns)
}

export async function harvestJavaScript(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const rootRaw = await readTextFile(scanDir, 'package.json')
  const rootPkg = rootRaw ? parseJsonSafe<PackageJson>(rootRaw) : null
  const rootName = rootPkg?.name

  const memberManifests = await workspacePackageManifests(scanDir)
  const manifests = memberManifests.length > 0 ? memberManifests : rootRaw ? ['package.json'] : []

  for (const relPath of manifests) {
    const raw = await readTextFile(scanDir, relPath)
    if (!raw) continue
    const pkg = parseJsonSafe<PackageJson>(raw)
    if (!pkg?.name) continue

    const { kind, confidence } = classifyPackageKind(pkg)
    const aliases = new Set<string>([pkg.name, unscoped(pkg.name)])
    const dirName = manifestDirName(relPath)
    if (dirName) aliases.add(dirName)
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const binName of Object.keys(pkg.bin)) aliases.add(binName)
    }

    candidates.push({
      kind,
      canonicalName: pkg.name,
      aliases: [...aliases],
      ...(pkg.description ? { gloss: pkg.description } : {}),
      sourceFile: relPath,
      sourceKind: 'manifest',
      confidence,
      contentHash: hashContent(raw),
      ecosystem: ECOSYSTEM,
    })

    if (rootName && pkg.name !== rootName) {
      edges.push({ fromName: pkg.name, toName: rootName, edgeType: 'part_of' })
    }
  }

  return { candidates, edges }
}

export const javaScriptHarvester: EcosystemHarvester = {
  id: ECOSYSTEM,
  detect: ['package.json', '*/package.json', 'pnpm-workspace.yaml'],
  harvest: harvestJavaScript,
}
