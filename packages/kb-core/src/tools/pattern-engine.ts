/**
 * YAML-driven source pattern engine for tier-4 (and OpenAPI path) harvest.
 * Ecosystem YAML `source_patterns` select named strategies; regex rules need no new TS.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { type SourcePattern, loadAllSourcePatterns } from './ecosystem-config.js'
import type { EntityKind, EntitySourceKind } from './entity-registry.js'

export interface EntityCandidate {
  kind: EntityKind
  canonicalName: string
  aliases: string[]
  gloss?: string
  sourceFile: string
  sourceKind: EntitySourceKind
  contentHash: string
}

export interface HarvestResult {
  candidates: EntityCandidate[]
  edges: []
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
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

export async function walkSourceFiles(
  root: string,
  opts: { extensions?: Set<string>; basenames?: Set<string>; maxFiles?: number } = {}
): Promise<string[]> {
  const out: string[] = []
  const maxFiles = opts.maxFiles ?? 2500
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

const ROUTE_CAP = 200
const APP_CONCEPT_CAP = 160
const MODEL_CAP = 160

const ROUTE_FILE_EXT_RE =
  /\.(pem|crt|key|py|ts|tsx|js|jsx|mjs|cjs|go|java|kt|rb|cs|php|rs|scala|hs|cpp|cc|h|hpp|prisma|sql|graphql|gql|md|json|mitm|ya?ml|toml|txt|png|jpg|svg)$/i

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

export type PrismaSchemaAtom = {
  /** Prisma declaration keyword (enum stays kind `model` at emit time). */
  decl: 'model' | 'enum' | 'view' | 'type'
  name: string
  /** DB table / enum type name from block-level `@@map("…")`, if any. */
  mapAlias?: string
}

const PRISMA_DECL_GLOSS: Record<PrismaSchemaAtom['decl'], string> = {
  model: 'Prisma model',
  enum: 'Prisma enum',
  view: 'Prisma view',
  type: 'Prisma composite type',
}

/**
 * Prisma schema declaration atoms: `model` / `enum` / `view` / composite `type`,
 * plus block-level `@@map("…")` table aliases. Skips `generator` / `datasource`
 * and field-level `@map` (column noise). Brace-aware so `@default("{}")` is safe.
 */
export function prismaSchemaAtoms(raw: string): PrismaSchemaAtom[] {
  const atoms: PrismaSchemaAtom[] = []
  const startRe = /\b(model|enum|view|type)\s+([A-Z][A-Za-z0-9_]*)\s*\{/g
  for (;;) {
    const m = startRe.exec(raw)
    if (!m) break
    const decl = m[1] as PrismaSchemaAtom['decl']
    const name = m[2]
    if (!name) continue
    const bodyStart = m.index + m[0].length
    let depth = 1
    let i = bodyStart
    let inString: '"' | "'" | null = null
    while (i < raw.length && depth > 0) {
      const ch = raw[i]
      if (ch === undefined) break
      if (inString) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === inString) inString = null
        i += 1
        continue
      }
      if (ch === '"' || ch === "'") {
        inString = ch
        i += 1
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    if (depth !== 0) continue
    const body = raw.slice(bodyStart, i - 1)
    const mapM = body.match(/@@map\s*\(\s*["']([^"']+)["']\s*\)/)
    const mapAlias = mapM?.[1]
    atoms.push(mapAlias ? { decl, name, mapAlias } : { decl, name })
    startRe.lastIndex = i
  }
  return atoms
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
  const m = annoBlock.match(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]+)['"]/)
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
    cls.bodyEnd = next ? next.bodyStart - 1 : raw.length
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
  const barePath = new RegExp(`\\b${pathExpr}\\s*(?:===|==)\\s*['"](\\/[^'"]+)['"]`, 'g')
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
  for (const m of raw.matchAll(/\.include_router\s*\([^,)]+,\s*prefix\s*=\s*['"]([^'"]+)['"]/g)) {
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
  for (const m of raw.matchAll(/\b([A-Za-z_]\w*)\s*(?::?=)\s*\w+\.Group\s*\(\s*"(\/[^"]*)"/g)) {
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
    for (const m of trimmed.matchAll(/\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]/g)) {
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
  for (const m of raw.matchAll(/\b(?:Route|Mount|WebSocketRoute)\s*\(\s*['"](\/[^'"]+)['"]/g)) {
    if (m[1]) push(m[1])
  }
  for (const m of raw.matchAll(/\.add_route\s*\(\s*['"](\/[^'"]+)['"]/g)) {
    if (m[1]) push(m[1])
  }
  for (const m of raw.matchAll(/\badd_api_route\s*\(\s*['"](\/[^'"]+)['"]/g)) {
    if (m[1]) push(m[1])
  }
  return found
}

/** Resolve a same-document OpenAPI JSON Pointer (`#/components/...`). */
export function resolveOpenApiRef(doc: unknown, ref: string): unknown {
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
 * filesystem routes. Never load-bearing for entity identity.
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

export type PatternHit = {
  name: string
  alias?: string
  aliases?: string[]
  kind?: EntityKind
  gloss?: string
}

function passesFilter(filter: SourcePattern['filter'], name: string): boolean {
  if (filter === 'none') return true
  if (filter === 'plausible_http_route') return isPlausibleHttpRoute(name)
  if (filter === 'plausible_type_name') return isPlausibleTypeName(name)
  if (filter === 'plausible_model_name') return isPlausibleModelName(name)
  return true
}

function transformGroup(value: string, transform: string | undefined): string {
  if (!transform) return value
  if (transform === 'upper') return value.toUpperCase()
  if (transform === 'lower') return value.toLowerCase()
  if (transform === 'class_leaf') return value.split('.').pop()?.split('::').pop() ?? value
  if (transform === 'http_verb') {
    const v = value.toUpperCase()
    return v === 'ANY' || v === 'HANDLE' ? 'ANY' : v
  }
  if (transform === 'map_verb') {
    return value === 'Methods' || value === 'Group' ? 'ANY' : value.toUpperCase()
  }
  if (transform === 'slim_verb') {
    const v = value.toUpperCase()
    return v === 'ANY' ? '' : v // empty → path-only handled by template consumer
  }
  return value
}

function renderTemplate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\{(\d+)(?:\|([a-z_]+))?\}/g, (_, g, tr) => {
    const idx = Number(g)
    const raw = match[idx] ?? ''
    let v = transformGroup(raw, tr)
    if (tr === '/') {
      v = raw.startsWith('/') ? raw : `/${raw}`
    }
    return v
  })
}

function applyNameTemplate(rule: SourcePattern, match: RegExpMatchArray): string | null {
  if (rule.name_template === '{1|slim_verb} {2}' || rule.name_template?.includes('slim_verb')) {
    const verb = (match[1] ?? '').toUpperCase()
    const routePath = match[2]
    if (!routePath) return null
    if (verb === 'ANY') return routePath
    return `${verb} ${routePath}`
  }
  if (rule.map_verbs_group !== undefined && rule.path_group !== undefined) {
    const verbs = match[rule.map_verbs_group] ?? ''
    const routePath = match[rule.path_group]
    if (!routePath) return null
    // Caller expands multiple — return sentinel; handled in regex strategy
    return `__MAP__:${verbs}::${routePath}`
  }
  if (rule.name_template) {
    let name = renderTemplate(rule.name_template, match)
    // Fix slim empty verb " {path}"
    name = name.replace(/^\s+/, '')
    if (rule.name_template.includes('|/')) {
      // already handled via {1|/} custom — renderTemplate treats |/ as transform '/'
    }
    // Support {1|/} — transform key is '/'
    if (/\{(\d+)\|\/\}/.test(rule.name_template)) {
      name = rule.name_template
        .replace(/\{(\d+)\|\/\}/g, (_, g) => {
          const raw = match[Number(g)] ?? ''
          return raw.startsWith('/') ? raw : `/${raw}`
        })
        .replace(/\{(\d+)(?:\|([a-z_]+))?\}/g, (whole, g, tr) => {
          if (whole.includes('|/')) return whole
          return transformGroup(match[Number(g)] ?? '', tr)
        })
      // simpler re-render:
      name = rule.name_template.replace(/\{(\d+)(?:\|([^}]+))?\}/g, (_, g, tr) => {
        const raw = match[Number(g)] ?? ''
        if (tr === '/') return raw.startsWith('/') ? raw : `/${raw}`
        return transformGroup(raw, tr)
      })
    }
    return name
  }
  const g = rule.name_group ?? 1
  return match[g] ?? null
}

function aliasesFromMatch(rule: SourcePattern, match: RegExpMatchArray, name: string): string[] {
  if (!rule.alias_groups?.length) return [name]
  const aliases = new Set<string>([name])
  for (const g of rule.alias_groups) {
    const v = match[g]
    if (!v) continue
    const leaf = v.split('::').pop()?.split('.').pop() ?? v
    if (rule.kind === 'model' && !isPlausibleModelName(leaf) && leaf !== name) continue
    aliases.add(leaf)
    if (v !== leaf) aliases.add(v)
  }
  return [...aliases]
}

function fileMatchesRule(relPosix: string, rule: SourcePattern): boolean {
  const ext = path.extname(relPosix).toLowerCase()
  const base = path.basename(relPosix)
  const suffixOk =
    !rule.files.path_suffixes?.length ||
    rule.files.path_suffixes.some(
      s => relPosix === s || relPosix.endsWith(`/${s}`) || relPosix.endsWith(s)
    )
  if (!suffixOk) return false
  const basenameOk = !rule.files.basenames?.length || rule.files.basenames.includes(base)
  if (!basenameOk) return false
  const extOk = !rule.files.extensions?.length || rule.files.extensions.includes(ext)
  if (!extOk) return false
  // At least one constraint must be present (avoid matching every file).
  return Boolean(
    rule.files.extensions?.length ||
      rule.files.basenames?.length ||
      rule.files.path_suffixes?.length
  )
}

function collectExtensions(patterns: SourcePattern[]): Set<string> {
  const exts = new Set<string>()
  for (const p of patterns) {
    for (const e of p.files.extensions ?? []) exts.add(e)
  }
  return exts
}

function runRegexRule(rule: SourcePattern, raw: string): PatternHit[] {
  const re = rule.compiledRegex
  if (!re) return []
  const hits: PatternHit[] = []
  if (rule.name_from === 'persistent_th') {
    for (const m of raw.matchAll(re)) {
      const block = m[1] ?? ''
      for (const line of block.split('\n')) {
        const modelLine = line.match(/^([A-Z][A-Za-z0-9_]*)(?:\s+json)?\s*$/)
        if (modelLine?.[1]) hits.push({ name: modelLine[1] })
      }
    }
    return hits
  }
  for (const m of raw.matchAll(re)) {
    if (rule.map_verbs_group !== undefined && rule.path_group !== undefined) {
      const verbs = m[rule.map_verbs_group] ?? ''
      const routePath = m[rule.path_group]
      if (!routePath) continue
      for (const vm of verbs.matchAll(/['"](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"]/gi)) {
        if (vm[1]) hits.push({ name: `${vm[1].toUpperCase()} ${routePath}` })
      }
      continue
    }
    const name = applyNameTemplate(rule, m)
    if (!name) continue
    if (
      rule.require_leading_slash &&
      !name.startsWith('/') &&
      !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)\s+\//i.test(name)
    ) {
      continue
    }
    if (rule.skip_names?.includes(name)) continue
    const aliases = aliasesFromMatch(rule, m, name)
    hits.push({
      name,
      aliases,
      ...(aliases.length > 1 ? { alias: aliases.find(a => a !== name) } : {}),
      gloss: rule.gloss,
    })
    if (rule.emit_extra_group_as_model !== undefined) {
      const extra = m[rule.emit_extra_group_as_model]
      if (extra) {
        const table = transformGroup(extra, undefined)
        hits.push({ name: table, aliases: [table], gloss: rule.gloss, kind: 'model' })
      }
    }
  }
  return hits
}

function runJoinStyle(rule: SourcePattern, raw: string, relPosix: string): PatternHit[] {
  const style = rule.join_style ?? ''
  if (rule.strategy === 'class_method_prefix_join') {
    if (style === 'nest') return nestJoinedRoutes(raw)
    if (style === 'nest_global_prefix') return nestGlobalPrefixRoutes(raw)
    if (style === 'spring') return springMappingPaths(raw)
    if (style === 'micronaut') return micronautJoinedRoutes(raw)
    if (style === 'jaxrs') return jaxrsJoinedRoutes(raw)
    throw new Error(`Unknown class_method_prefix_join join_style "${style}" in rule ${rule.id}`)
  }
  if (rule.strategy === 'router_group_prefix_join') {
    if (style === 'go_group') return goGroupPrefixRoutes(raw)
    if (style === 'fastapi') return fastapiRouterPrefixRoutes(raw)
    if (style === 'asgi') return asgiStyleRoutes(raw)
    if (style === 'raw_node_http') return rawNodeHttpRoutes(raw)
    throw new Error(`Unknown router_group_prefix_join join_style "${style}" in rule ${rule.id}`)
  }
  if (rule.strategy === 'rails_resources_crud') {
    if (style === 'laravel') return laravelRouteHits(raw)
    if (relPosix.endsWith('routes.rb') || style === '') return railsNestedRoutes(raw)
    return []
  }
  return []
}

function laravelRouteHits(raw: string): PatternHit[] {
  const found: PatternHit[] = []
  for (const m of raw.matchAll(
    /\bRoute::(get|post|put|patch|delete|options|any|match|resource|apiResource)\s*\(\s*['"]([^'"]+)['"]/gi
  )) {
    const method = (m[1] ?? 'GET').toUpperCase()
    const routePath = m[2]
    if (!routePath) continue
    if (method === 'RESOURCE' || method === 'APIRESOURCE') {
      const base = routePath.startsWith('/') ? routePath : `/${routePath}`
      for (const r of expandRailsResourceRoutes(base.replace(/^\//, ''))) {
        found.push({ name: r.startsWith('/') || r.includes(' ') ? r : `/${r}` })
      }
    } else if (method === 'ANY' || method === 'MATCH') {
      found.push({ name: routePath })
    } else {
      found.push({ name: `${method} ${routePath}` })
    }
  }
  return found
}

function runDjangoInclude(
  raw: string,
  relPosix: string,
  djangoModulePrefixes: Map<string, string[]>
): PatternHit[] {
  const found: PatternHit[] = []
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
  for (const [mod, prefixes] of djangoModulePrefixes) {
    if (!djangoUrlsModuleFiles(mod).some(f => relPosix === f || relPosix.endsWith(`/${f}`)))
      continue
    for (const prefix of prefixes) {
      for (const seg of localPaths) {
        if (raw.includes('include(') && seg === prefix) continue
        found.push({ name: djangoJoinPrefix(prefix, seg) })
      }
    }
  }
  return found
}

function runSymfonyYaml(raw: string, relPosix: string): PatternHit[] {
  const looksRoutes =
    /(?:^|\/)routes[^/]*\.(ya?ml)$/i.test(relPosix) ||
    /(?:^|\/)config\/routes?\//i.test(relPosix) ||
    (/^\s*path\s*:\s*['"]?\//m.test(raw) &&
      (/^\s*controller\s*:/m.test(raw) || /^\s*methods\s*:/m.test(raw)))
  if (!looksRoutes || /^\s*openapi\s*:/m.test(raw) || /^\s*swagger\s*:/m.test(raw)) return []
  const found: PatternHit[] = []
  for (const m of raw.matchAll(/(^|\n)([A-Za-z_][\w.]*)\s*:\s*\n((?:[ \t]+.+(?:\n|$))*)/g)) {
    const block = m[3] ?? ''
    const pathMatch = block.match(/^\s*path\s*:\s*['"]?([^\s'"]+)['"]?/m)
    if (!pathMatch?.[1]?.startsWith('/')) continue
    const routePath = pathMatch[1]
    const methodsMatch = block.match(/^\s*methods\s*:\s*\[([^\]]+)\]/m)
    if (methodsMatch?.[1]) {
      for (const vm of methodsMatch[1].matchAll(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/gi)) {
        if (vm[1]) found.push({ name: `${vm[1].toUpperCase()} ${routePath}` })
      }
    } else {
      found.push({ name: routePath })
    }
  }
  for (const m of raw.matchAll(/^\s*-\s*path\s*:\s*['"]?([^\s'"]+)['"]?/gm)) {
    if (m[1]?.startsWith('/')) found.push({ name: m[1] })
  }
  return found
}

function runTrpc(raw: string): PatternHit[] {
  const found: PatternHit[] = []
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
  return found
}

function runPrisma(raw: string): PatternHit[] {
  const hits: PatternHit[] = []
  for (const atom of prismaSchemaAtoms(raw)) {
    const aliases =
      atom.mapAlias && isPlausibleModelName(atom.mapAlias)
        ? [atom.name, atom.mapAlias]
        : [atom.name]
    hits.push({
      name: atom.name,
      aliases,
      gloss: PRISMA_DECL_GLOSS[atom.decl],
    })
  }
  return hits
}

function runEmbeddedSql(raw: string): PatternHit[] {
  if (!/\bCREATE\s+TABLE\b/i.test(raw)) return []
  const hits: PatternHit[] = []
  for (const m of raw.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z_][\w]*["`]?\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi
  )) {
    if (m[1]) hits.push({ name: m[1] })
  }
  return hits
}

export function runOpenApiPathItems(
  parsed: {
    paths?: Record<string, Record<string, unknown> | undefined>
  },
  rel: string,
  hash: string
): EntityCandidate[] {
  const out: EntityCandidate[] = []
  const paths = parsed?.paths
  if (!paths || typeof paths !== 'object') return out
  for (const [routePath, item] of Object.entries(paths)) {
    if (!routePath.startsWith('/') || !isPlausibleHttpRoute(routePath)) continue
    out.push({
      kind: 'api',
      canonicalName: routePath,
      aliases: [routePath],
      gloss: 'OpenAPI path item',
      sourceFile: rel,
      sourceKind: 'source-pattern',
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
      out.push({
        kind: 'api',
        canonicalName: name,
        aliases: [name],
        gloss: 'OpenAPI operation',
        sourceFile: rel,
        sourceKind: 'source-pattern',
        contentHash: hash,
      })
    }
  }
  return out
}

function hitsForRule(
  rule: SourcePattern,
  raw: string,
  relPosix: string,
  djangoModulePrefixes: Map<string, string[]>
): PatternHit[] {
  switch (rule.strategy) {
    case 'regex':
      return runRegexRule(rule, raw)
    case 'class_method_prefix_join':
    case 'router_group_prefix_join':
    case 'rails_resources_crud':
      return runJoinStyle(rule, raw, relPosix)
    case 'django_include_join':
      return runDjangoInclude(raw, relPosix, djangoModulePrefixes)
    case 'symfony_yaml_routes':
      return runSymfonyYaml(raw, relPosix)
    case 'trpc_procedures':
      return runTrpc(raw)
    case 'prisma_schema_blocks':
      return runPrisma(raw)
    case 'embedded_sql_ddl':
      return runEmbeddedSql(raw)
    case 'next_filesystem_routes': {
      const nextHit = nextRouteFromFile(relPosix)
      if (!nextHit) return []
      return [
        {
          name: nextHit.path,
          kind: nextHit.kind,
          gloss: nextHit.kind === 'surface' ? 'Next.js page' : 'Next.js route handler',
        },
      ]
    }
    case 'openapi_path_items':
      return [] // handled in contracts harvest
    default: {
      const _exhaustive: never = rule.strategy
      throw new Error(`Unknown strategy: ${String(_exhaustive)}`)
    }
  }
}

export interface RunSourcePatternsOpts {
  phase: 'routes' | 'app'
  patterns?: SourcePattern[]
}

/**
 * Walk the repo and run YAML `source_patterns` for the given harvest phase.
 */
export async function runSourcePatterns(
  scanDir: string,
  opts: RunSourcePatternsOpts
): Promise<HarvestResult> {
  const all = opts.patterns ?? loadAllSourcePatterns()
  const patterns = all.filter(p => p.phase === opts.phase)
  if (patterns.some(p => !PATTERN_STRATEGIES_RUNTIME.has(p.strategy))) {
    // validated at load; belt-and-suspenders
  }

  const candidates: EntityCandidate[] = []
  const seen = new Set<string>()
  let moduleCount = 0
  let modelCount = 0

  const exts = collectExtensions(patterns)
  // Always include yaml for symfony / play routes basename walk
  for (const e of ['.yaml', '.yml', '.prisma', '.sql', '.graphql', '.gql', '.xml', '.json']) {
    if ([...patterns].some(p => p.files.extensions?.includes(e))) exts.add(e)
  }
  const files = await walkSourceFiles(scanDir, {
    extensions: exts.size ? exts : undefined,
    maxFiles: 2500,
  })
  for (const f of await walkSourceFiles(scanDir, {
    basenames: new Set(['routes']),
    maxFiles: 50,
  })) {
    const relPosix = path.relative(scanDir, f).replace(/\\/g, '/')
    if (relPosix === 'conf/routes' || relPosix.endsWith('/conf/routes')) files.push(f)
  }

  const djangoModulePrefixes = new Map<string, string[]>()
  if (patterns.some(p => p.strategy === 'django_include_join')) {
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
  }

  const pushHit = (rule: SourcePattern, hit: PatternHit, rel: string, hash: string) => {
    const kind = hit.kind ?? rule.kind
    const name = hit.name
    if (!passesFilter(rule.filter, name)) return
    if (opts.phase === 'routes' && candidates.length >= ROUTE_CAP) return
    if (opts.phase === 'app') {
      if (kind === 'module' && moduleCount >= APP_CONCEPT_CAP) return
      if (kind === 'model' && modelCount >= MODEL_CAP) return
    }
    const aliases = hit.aliases?.length ? hit.aliases : hit.alias ? [name, hit.alias] : [name]
    const before = candidates.length
    const cap = opts.phase === 'routes' ? ROUTE_CAP : APP_CONCEPT_CAP + MODEL_CAP
    pushUniqueCandidate(candidates, seen, cap, {
      kind,
      canonicalName: name,
      aliases: [...new Set(aliases)],
      gloss: hit.gloss ?? rule.gloss,
      sourceFile: rel,
      sourceKind: 'source-pattern',
      contentHash: hash,
    })
    if (opts.phase === 'app' && candidates.length > before) {
      if (kind === 'module') moduleCount += 1
      else if (kind === 'model') modelCount += 1
    }
  }

  // Special-case: next_filesystem can run without reading (path only) — still read once per file for other rules
  for (const filePath of [...new Set(files)].sort()) {
    if (opts.phase === 'routes' && candidates.length >= ROUTE_CAP) break
    if (opts.phase === 'app' && moduleCount >= APP_CONCEPT_CAP && modelCount >= MODEL_CAP) break
    const rel = path.relative(scanDir, filePath)
    const relPosix = rel.replace(/\\/g, '/')
    const matching = patterns.filter(p => fileMatchesRule(relPosix, p))
    if (matching.length === 0) continue

    const needsContent = matching.some(p => p.strategy !== 'next_filesystem_routes')
    let raw: string | null = null
    let hash = sha256(relPosix)
    if (needsContent) {
      raw = await readText(filePath)
      if (!raw) {
        // still allow next-only
        for (const rule of matching.filter(p => p.strategy === 'next_filesystem_routes')) {
          for (const hit of hitsForRule(rule, '', relPosix, djangoModulePrefixes)) {
            pushHit(rule, hit, rel, hash)
          }
        }
        continue
      }
      hash = sha256(raw)
    }

    for (const rule of matching) {
      if (rule.strategy === 'next_filesystem_routes') {
        for (const hit of hitsForRule(rule, '', relPosix, djangoModulePrefixes)) {
          pushHit(rule, hit, rel, hash)
        }
        continue
      }
      if (raw === null) continue
      // Hibernate / JPA XML gate (avoid unrelated XML)
      if (
        relPosix.endsWith('.xml') &&
        (rule.id.includes('hibernate') ||
          rule.id.includes('jpa_orm') ||
          rule.gloss?.includes('Hibernate') ||
          rule.gloss?.includes('orm.xml'))
      ) {
        const looksHibernate =
          /\.hbm\.xml$/i.test(relPosix) ||
          /(?:^|\/)orm\.xml$/i.test(relPosix) ||
          /<hibernate-mapping\b/i.test(raw) ||
          /<entity-mappings\b/i.test(raw) ||
          /xmlns\s*=\s*["'][^"']*hibernate/i.test(raw)
        if (!looksHibernate) continue
      }
      for (const hit of hitsForRule(rule, raw, relPosix, djangoModulePrefixes)) {
        // Fix alias list for patterns with alias_groups — rebuild from last match is hard;
        // for module/model with alias_groups in regex, re-parse aliases:
        if (rule.strategy === 'regex' && rule.alias_groups && rule.compiledRegex) {
          // hits already have name; enrich aliases when emitting
        }
        pushHit(rule, hit, rel, hash)
      }
    }
  }

  return { candidates, edges: [] }
}

const PATTERN_STRATEGIES_RUNTIME = new Set([
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
])

/** Fail loud when YAML names an unknown strategy (also enforced in ecosystem-config). */
export function assertKnownStrategy(strategy: string): void {
  if (!PATTERN_STRATEGIES_RUNTIME.has(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}`)
  }
}
