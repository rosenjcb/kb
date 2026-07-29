/**
 * Go ecosystem harvester.
 *
 * Two discovery mechanisms run together, because a repo may use either or both:
 * `go.work` workspaces and nested `go.mod` module roots. The dominant Go
 * structural signal is the `cmd/<name>/` convention — each subdirectory under
 * `cmd/` is a binary whose directory name IS the binary name, which is exactly
 * the operator-facing vocabulary we want as an alias.
 *
 * No AST: the directory convention is the contract, and `go.mod` is a simple
 * line-oriented format that regex handles safely.
 */

import path from 'node:path'
import {
  findManifests,
  hashContent,
  manifestDirName,
  readTextFile,
} from './fs-utils.js'
import type { CandidateEdge, EcosystemHarvester, EntityCandidate, HarvestResult } from './types.js'
import type { EntityKind } from '../entity-registry.js'

const ECOSYSTEM = 'go'

/** HTTP / RPC service frameworks — import-path prefixes matched against `require`. */
const SERVICE_FRAMEWORKS = [
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'github.com/go-chi/chi',
  'github.com/gorilla/mux',
  'github.com/beego/beego',
  'github.com/astaxie/beego',
  'google.golang.org/grpc',
  'connectrpc.com/connect',
  'github.com/bufbuild/connect-go',
  'github.com/twitchtv/twirp',
]

/** GraphQL / API-definition libraries → `api` kind. */
const API_FRAMEWORKS = ['github.com/99designs/gqlgen', 'github.com/graphql-go/graphql']

/**
 * CLI frameworks. `github.com/spf13/pflag` is deliberately absent: Cobra pulls
 * it in transitively, so counting it would double-count the same evidence.
 */
const CLI_FRAMEWORKS = [
  'github.com/spf13/cobra',
  'github.com/urfave/cli',
  'github.com/alecthomas/kingpin',
  'github.com/jessevdk/go-flags',
  'github.com/integrii/flaggy',
]

/** Background worker / queue / workflow frameworks — still `service`-kind, but worker-shaped. */
const WORKER_FRAMEWORKS = [
  'github.com/hibiken/asynq',
  'github.com/riverqueue/river',
  'github.com/RichardKnop/machinery',
  'github.com/gocraft/work',
  'go.temporal.io/sdk',
  'github.com/ThreeDotsLabs/watermill',
]

/** Server-rendered UI — a Go binary that renders a dashboard is a `surface`, not a `service`. */
const SURFACE_FRAMEWORKS = ['github.com/a-h/templ']

interface GoModule {
  /** Full module path including any `/vN` suffix. */
  modulePath: string
  /** Repo-relative path of the go.mod. */
  sourceFile: string
  /** Repo-relative directory containing the go.mod (`''` for repo root). */
  dir: string
  requires: string[]
  contentHash: string
}

/**
 * Parse the directives we care about from go.mod. Deliberately ignores
 * `exclude`, `retract`, and — importantly — Go 1.24's `tool` directive, which
 * pins build-time tools (the successor to the `tools.go` pattern) and would
 * otherwise pollute framework detection the same way devDependencies would.
 */
export function parseGoMod(raw: string): { modulePath?: string; requires: string[] } {
  const moduleMatch = raw.match(/^\s*module\s+(\S+)/m)
  const requires: string[] = []

  // Block form: require ( ... )
  const blockRe = /^\s*require\s*\(([\s\S]*?)^\s*\)/gm
  let block: RegExpExecArray | null = blockRe.exec(raw)
  while (block !== null) {
    for (const line of (block[1] ?? '').split('\n')) {
      const stripped = line.replace(/\/\/.*$/, '').trim()
      if (!stripped) continue
      const [modPath] = stripped.split(/\s+/)
      if (modPath) requires.push(modPath)
    }
    block = blockRe.exec(raw)
  }

  // Single-line form: require example.com/mod v1.2.3
  const singleRe = /^\s*require\s+(?!\()(\S+)/gm
  let single: RegExpExecArray | null = singleRe.exec(raw)
  while (single !== null) {
    if (single[1]) requires.push(single[1])
    single = singleRe.exec(raw)
  }

  return { ...(moduleMatch?.[1] ? { modulePath: moduleMatch[1] } : {}), requires }
}

/**
 * Aliases for a module path. Go's import-compatibility rule puts `/vN` (N>=2)
 * in the path itself, so `.../widget-api/v3` and `.../widget-api` name the same
 * logical thing — emitting the unsuffixed path as an alias is what stops a v2
 * module from reading as a different service than its v1 sibling.
 */
export function goModuleAliases(modulePath: string, dirName: string): string[] {
  const aliases = new Set<string>()
  const segments = modulePath.split('/')
  const last = segments[segments.length - 1] ?? ''

  if (/^v[0-9]+$/.test(last) && segments.length > 1) {
    const bare = segments.slice(0, -1).join('/')
    aliases.add(bare)
    const bareLast = segments[segments.length - 2]
    if (bareLast) aliases.add(bareLast)
  } else if (last) {
    aliases.add(last)
  }
  if (dirName) aliases.add(dirName)
  return [...aliases]
}

function matchesAny(requires: string[], prefixes: string[]): boolean {
  return requires.some(req => prefixes.some(prefix => req === prefix || req.startsWith(`${prefix}/`)))
}

/** Kind for a `cmd/<name>` binary, disambiguated by the module's declared frameworks. */
function classifyBinary(requires: string[]): { kind: EntityKind; confidence: number } {
  if (matchesAny(requires, CLI_FRAMEWORKS)) return { kind: 'cli', confidence: 0.85 }
  if (matchesAny(requires, SURFACE_FRAMEWORKS)) return { kind: 'surface', confidence: 0.6 }
  if (matchesAny(requires, SERVICE_FRAMEWORKS) || matchesAny(requires, WORKER_FRAMEWORKS)) {
    return { kind: 'service', confidence: 0.85 }
  }
  // A cmd/ binary with no framework evidence is still a binary — Go 1.22's
  // pattern-routing pushed many services back onto stdlib net/http.
  return { kind: 'service', confidence: 0.6 }
}

/** Kind for a module that ships no binaries. */
function classifyModule(requires: string[], hasBinaries: boolean): { kind: EntityKind; confidence: number } {
  if (hasBinaries) return { kind: 'module', confidence: 0.7 }
  if (matchesAny(requires, API_FRAMEWORKS)) return { kind: 'api', confidence: 0.7 }
  return { kind: 'library', confidence: 0.5 }
}

/** `cmd/*` subdirectories containing Go source, relative to a module root. */
async function findCommandDirs(scanDir: string, moduleDir: string): Promise<Array<{ name: string; sourceFile: string }>> {
  const prefix = moduleDir ? `${moduleDir}/` : ''
  const direct = await findManifests(scanDir, [`${prefix}cmd/*/*.go`], { deep: 12 })
  const nested = await findManifests(scanDir, [`${prefix}cmd/*/*/*.go`], { deep: 12 })

  const out = new Map<string, string>()
  for (const rel of direct) {
    const dir = path.posix.dirname(rel)
    const name = path.posix.basename(dir)
    if (!out.has(name)) out.set(name, `${dir}/main.go`)
  }
  for (const rel of nested) {
    const dir = path.posix.dirname(rel)
    const leaf = path.posix.basename(dir)
    const group = path.posix.basename(path.posix.dirname(dir))
    // Skip when the group dir already produced a candidate at the level above.
    if (out.has(group)) continue
    const name = `${group}-${leaf}`
    if (!out.has(name)) out.set(name, `${dir}/main.go`)
  }
  return [...out].map(([name, sourceFile]) => ({ name, sourceFile }))
}

export async function harvestGo(scanDir: string): Promise<HarvestResult> {
  const candidates: EntityCandidate[] = []
  const edges: CandidateEdge[] = []

  const goModPaths = await findManifests(scanDir, ['go.mod', '**/go.mod'], { deep: 8 })
  const modules: GoModule[] = []

  for (const relPath of goModPaths) {
    // testdata/ go.mod files are conventionally self-contained fixtures, not
    // real modules (golang/go#27852) — fs-utils already excludes testdata, this
    // is belt-and-braces for a nested path fast-glob's ignore may not catch.
    if (relPath.split('/').includes('testdata')) continue
    const raw = await readTextFile(scanDir, relPath)
    if (!raw) continue
    const { modulePath, requires } = parseGoMod(raw)
    if (!modulePath) continue
    const dir = path.posix.dirname(relPath)
    modules.push({
      modulePath,
      sourceFile: relPath,
      dir: dir === '.' ? '' : dir,
      requires,
      contentHash: hashContent(raw),
    })
  }

  for (const mod of modules) {
    const dirName = mod.dir ? path.posix.basename(mod.dir) : manifestDirName(mod.sourceFile)
    const commands = await findCommandDirs(scanDir, mod.dir)
    const { kind, confidence } = classifyModule(mod.requires, commands.length > 0)

    candidates.push({
      kind,
      canonicalName: mod.modulePath,
      aliases: goModuleAliases(mod.modulePath, dirName),
      sourceFile: mod.sourceFile,
      sourceKind: 'manifest',
      confidence,
      contentHash: mod.contentHash,
      ecosystem: ECOSYSTEM,
    })

    for (const command of commands) {
      const binary = classifyBinary(mod.requires)
      candidates.push({
        kind: binary.kind,
        // Globally unique and traceable; the bare binary name is the alias
        // operators actually type.
        canonicalName: `${mod.modulePath}/cmd/${command.name}`,
        aliases: [command.name],
        sourceFile: command.sourceFile,
        sourceKind: 'manifest',
        confidence: binary.confidence,
        contentHash: mod.contentHash,
        ecosystem: ECOSYSTEM,
      })
      edges.push({
        fromName: `${mod.modulePath}/cmd/${command.name}`,
        toName: mod.modulePath,
        edgeType: 'part_of',
      })
    }
  }

  // go.work membership: explicit workspace topology when present.
  for (const workPath of await findManifests(scanDir, ['go.work', '**/go.work'], { deep: 4 })) {
    const raw = await readTextFile(scanDir, workPath)
    if (!raw) continue
    const workDir = path.posix.dirname(workPath)
    const uses = parseGoWorkUses(raw)
    for (const use of uses) {
      const resolved = path.posix.normalize(
        path.posix.join(workDir === '.' ? '' : workDir, use)
      )
      const target = modules.find(m => (m.dir || '.') === (resolved === '' ? '.' : resolved))
      if (target) {
        edges.push({ fromName: target.modulePath, toName: workspaceRootName(scanDir), edgeType: 'part_of' })
      }
    }
  }

  return { candidates, edges }
}

/** `use ./dir` and `use ( ... )` block forms. */
export function parseGoWorkUses(raw: string): string[] {
  const uses: string[] = []
  const blockRe = /^\s*use\s*\(([\s\S]*?)^\s*\)/gm
  let block: RegExpExecArray | null = blockRe.exec(raw)
  while (block !== null) {
    for (const line of (block[1] ?? '').split('\n')) {
      const stripped = line.replace(/\/\/.*$/, '').trim()
      if (stripped) uses.push(stripped)
    }
    block = blockRe.exec(raw)
  }
  const singleRe = /^\s*use\s+(?!\()(\S+)/gm
  let single: RegExpExecArray | null = singleRe.exec(raw)
  while (single !== null) {
    if (single[1]) uses.push(single[1])
    single = singleRe.exec(raw)
  }
  return uses
}

function workspaceRootName(scanDir: string): string {
  return path.basename(scanDir)
}

export const goHarvester: EcosystemHarvester = {
  id: ECOSYSTEM,
  detect: ['go.mod', '**/go.mod', 'go.work'],
  harvest: harvestGo,
}
