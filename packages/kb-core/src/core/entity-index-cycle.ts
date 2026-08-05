/**
 * `entity-index` scan cycle: deterministic entity harvest + fact↔entity linking
 * (packages/kb-core/src/tools/ECOSYSTEM_HARVESTERS.spec.md §4). Runs per repo after `document-facts`, so both
 * code facts and doc facts exist when links are written. Best-effort by design —
 * a failed harvest must never fail `kb init` / `kb scan`.
 *
 * Steps:
 *  1. Harvest entity candidates from manifest-class files (ecosystem-harvesters).
 *  2. Upsert entities + aliases into the registry (repo itself becomes an entity).
 *  3. Derive containment: every candidate is `part_of` the package that owns its
 *     source file, and every package is `part_of` the repo. Without this the tier-4
 *     entities (routes, models, modules) are orphans — the majority of the registry.
 *  4. Resolve harvested edges against this run's candidates, the repo entity, and the
 *     rest of the base's registry. Unresolved endpoints are counted, never dropped
 *     silently.
 *  5. Link facts whose subject/object normalizes to a known alias — exact match
 *     only; the un-harvested world stays unlinked and therefore unprunable.
 *  6. Deterministic collision screen → `distinct_from` edges with contrastive glosses.
 */

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEnvFalse } from '../config/env-boolean.js'
import type { CandidateEdge, EntityCandidate } from '../tools/ecosystem-harvesters.js'
import { harvestRepoEntities } from '../tools/ecosystem-harvesters.js'
import { EntityRegistry, normalizeEntityName } from '../tools/entity-registry.js'

export interface EntityIndexInput {
  baseDir: string
  scanDir: string
  /** Repo slug — becomes a `repo` entity and the `git_repo` on harvested entities. */
  gitRepo?: string
}

export interface EntityIndexResult {
  entitiesUpserted: number
  factsLinked: number
  collisions: number
  /** Relationship edges written to the registry (excludes `distinct_from`). */
  edgesWritten: number
  /**
   * `depends_on` edges whose target is not an entity this base knows about — almost
   * always a third-party package. Expected and healthy; reported to distinguish it
   * from `edgesDropped`.
   */
  edgesExternal: number
  /**
   * Structural edges (`part_of` / `belongs_to` / `owned_by`) whose endpoint could not
   * be resolved. Every one of these is a harvester bug: the edge names a container
   * that nothing harvested. Non-zero here means the graph is losing real structure.
   */
  edgesDropped: number
}

/** Kill switch: KB_ENTITY_INDEX=false skips the harvest entirely. */
export function isEntityIndexEnabled(): boolean {
  return !isEnvFalse(process.env.KB_ENTITY_INDEX)
}

/**
 * Manifest files that declare a package root. A candidate harvested from one of these
 * owns the directory the manifest sits in, which is what makes containment derivable.
 */
const PACKAGE_ROOT_MANIFESTS = new Set([
  'package.json',
  'go.mod',
  'pyproject.toml',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'package.yaml',
  'CMakeLists.txt',
])

/** True for manifests identified by extension rather than exact name. */
function isPackageRootManifest(sourceFile: string): boolean {
  const base = path.posix.basename(sourceFile.replace(/\\/g, '/'))
  if (PACKAGE_ROOT_MANIFESTS.has(base)) return true
  return base.endsWith('.gemspec') || base.endsWith('.cabal') || base.endsWith('.csproj')
}

/** Directory that owns a source file, as a normalized posix prefix (`''` for the root). */
function ownerDir(sourceFile: string): string {
  const posix = sourceFile.replace(/\\/g, '/')
  const dir = path.posix.dirname(posix)
  return dir === '.' || dir === '/' ? '' : dir
}

/**
 * Derive the containment backbone of the graph.
 *
 * Every candidate carries the file it was harvested from, and every package manifest
 * declares the directory it owns, so "which package is this route/model/module in" is
 * a deterministic longest-prefix match — no LLM, no guessing. Packages themselves are
 * contained by the repo. This is what turns a bag of names into a connected graph;
 * before it, tier-4 entities (the bulk of every registry) had no edges at all.
 */
export function deriveContainmentEdges(
  candidates: readonly EntityCandidate[],
  repoName?: string
): CandidateEdge[] {
  const packageRoots: Array<{ dir: string; name: string }> = []
  for (const candidate of candidates) {
    if (candidate.sourceKind !== 'manifest') continue
    if (!isPackageRootManifest(candidate.sourceFile)) continue
    packageRoots.push({ dir: ownerDir(candidate.sourceFile), name: candidate.canonicalName })
  }
  // Longest directory first so a workspace member wins over the repo root.
  packageRoots.sort((a, b) => b.dir.length - a.dir.length)

  const packageNames = new Set(packageRoots.map(p => normalizeEntityName(p.name)))
  const edges: CandidateEdge[] = []
  const seen = new Set<string>()

  const push = (fromName: string, toName: string): void => {
    const from = normalizeEntityName(fromName)
    const to = normalizeEntityName(toName)
    if (!from || !to || from === to) return
    const key = `${from}\0${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ fromName, toName, edgeType: 'part_of' })
  }

  for (const candidate of candidates) {
    const normalized = normalizeEntityName(candidate.canonicalName)
    const dir = ownerDir(candidate.sourceFile)
    const isPackageRoot =
      candidate.sourceKind === 'manifest' &&
      isPackageRootManifest(candidate.sourceFile) &&
      packageNames.has(normalized)

    if (isPackageRoot) {
      // A package is contained by an enclosing package when one exists (a workspace
      // member inside its root), otherwise directly by the repo.
      const parent = packageRoots.find(
        p => normalizeEntityName(p.name) !== normalized && isWithin(dir, p.dir)
      )
      if (parent) push(candidate.canonicalName, parent.name)
      else if (repoName) push(candidate.canonicalName, repoName)
      continue
    }

    const owner = packageRoots.find(p => isWithin(dir, p.dir))
    if (owner) push(candidate.canonicalName, owner.name)
    else if (repoName) push(candidate.canonicalName, repoName)
  }

  return edges
}

/** True when `dir` is `root` or lives underneath it (posix, prefix on a path boundary). */
function isWithin(dir: string, root: string): boolean {
  if (root === '') return true
  return dir === root || dir.startsWith(`${root}/`)
}

export async function runEntityIndexCycle(input: EntityIndexInput): Promise<EntityIndexResult> {
  const result: EntityIndexResult = {
    entitiesUpserted: 0,
    factsLinked: 0,
    collisions: 0,
    edgesWritten: 0,
    edgesExternal: 0,
    edgesDropped: 0,
  }
  if (!isEntityIndexEnabled()) return result

  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const registry = new EntityRegistry(dbPath)

  try {
    const idByName = new Map<string, string>()

    // The repo is itself an entity — repo-level scoping and entity-level scoping
    // share one vocabulary. It is registered as a resolvable edge endpoint too, so
    // things can be `part_of` the repo they live in.
    if (input.gitRepo) {
      const repoId = registry.upsertEntity({
        kind: 'repo',
        canonicalName: input.gitRepo,
        gitRepo: input.gitRepo,
        sourceKind: 'manifest',
      })
      idByName.set(normalizeEntityName(input.gitRepo), repoId)
      result.entitiesUpserted++
    }

    const harvest = await harvestRepoEntities(input.scanDir)
    for (const candidate of harvest.candidates) {
      const id = registry.upsertEntity({
        kind: candidate.kind,
        canonicalName: candidate.canonicalName,
        ...(candidate.gloss ? { gloss: candidate.gloss } : {}),
        ...(input.gitRepo ? { gitRepo: input.gitRepo } : {}),
        sourceKind: candidate.sourceKind,
        contentHash: candidate.contentHash,
      })
      idByName.set(normalizeEntityName(candidate.canonicalName), id)
      for (const alias of candidate.aliases) {
        registry.addAlias(id, alias, candidate.sourceKind)
      }
      result.entitiesUpserted++
    }

    const allEdges = [
      ...harvest.edges,
      ...deriveContainmentEdges(harvest.candidates, input.gitRepo),
    ]

    for (const edge of allEdges) {
      const from = resolveEndpoint(edge.fromName, idByName, registry)
      const to = resolveEndpoint(edge.toName, idByName, registry)
      if (from && to && from !== to) {
        registry.addEdge(from, to, edge.edgeType)
        result.edgesWritten++
        continue
      }
      if (from === to && from) continue
      // A `depends_on` target that resolves to nothing is a third-party package the
      // base has never indexed — expected. Anything else names a container that should
      // exist, so losing it is a harvester bug worth surfacing.
      if (edge.edgeType === 'depends_on') result.edgesExternal++
      else result.edgesDropped++
    }

    result.factsLinked = linkFactsToEntities(dbPath, registry)
    result.collisions = registry.detectCollisions()
  } finally {
    registry.close()
  }
  return result
}

/**
 * Resolve an edge endpoint name to an entity id: this run's candidates first, then the
 * rest of the base's registry (so a sibling repo's package can be the target of a
 * cross-repo `depends_on`). Ambiguous alias matches are skipped rather than guessed.
 */
function resolveEndpoint(
  name: string,
  idByName: Map<string, string>,
  registry: EntityRegistry
): string | undefined {
  const normalized = normalizeEntityName(name)
  if (!normalized) return undefined
  const local = idByName.get(normalized)
  if (local) return local
  const matches = registry.findEntityByName(name)
  if (matches.length !== 1) return undefined
  const match = matches[0]
  if (!match) return undefined
  idByName.set(normalized, match.id)
  return match.id
}

/**
 * Exact-match linking: a fact links to an entity only when its subject or object
 * normalizes to one of the entity's aliases. Longest-alias precedence is implicit
 * because the whole string must match — "internal services" as a subject can only
 * equal the surface's alias, never the service's.
 */
function linkFactsToEntities(dbPath: string, registry: EntityRegistry): number {
  const aliasToEntities = new Map<string, string[]>()
  for (const entity of registry.listEntities()) {
    for (const alias of registry.listAliases(entity.id)) {
      const existing = aliasToEntities.get(alias.normalized)
      if (existing) {
        if (!existing.includes(entity.id)) existing.push(entity.id)
      } else {
        aliasToEntities.set(alias.normalized, [entity.id])
      }
    }
  }
  if (aliasToEntities.size === 0) return 0

  const db = new DatabaseSync(dbPath, { readOnly: true })
  let linked = 0
  try {
    const rows = db
      .prepare(
        `SELECT id, subject, object FROM facts
         WHERE tombstoned_at IS NULL AND (subject != '' OR object != '')`
      )
      .all() as Array<{ id: string; subject: string; object: string }>
    for (const row of rows) {
      for (const [value, role] of [
        [row.subject, 'subject'],
        [row.object, 'object'],
      ] as const) {
        if (!value) continue
        const entityIds = aliasToEntities.get(normalizeEntityName(value))
        if (!entityIds) continue
        for (const entityId of entityIds) {
          registry.linkFact(row.id, entityId, role)
          linked++
        }
      }
    }
  } finally {
    db.close()
  }
  return linked
}
