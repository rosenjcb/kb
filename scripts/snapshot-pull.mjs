#!/usr/bin/env node
/**
 * `pnpm run snapshot:pull` — grab the snapshot the Fly.io demo is serving right
 * now and adopt it locally, so an eval never has to rebuild an index from scratch.
 *
 * The Fly builder publishes one immutable, sha256-stamped snapshot per base to
 * object storage (Tigris/S3) and flips a tiny `latest.json` pointer as the commit
 * point — see FLY_ORCHESTRATION.md. That published artifact is exactly what an
 * evaluation needs: a fully-built `.kb-index.sqlite` for `raylib`, `kb`, `fzf`, …
 * This script is the read-only consumer side of that contract:
 *
 *   latest.json → immutable version prefix → download → verify sha256
 *               → `kb-server import` into a local base (default `eval-<base>`)
 *
 * Everything it touches is already-published, immutable state; it never writes to
 * the bucket, never rolls a machine, and never needs the builder.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   pnpm run snapshot:pull                          # default base (kb) → base eval-kb
 *   pnpm run snapshot:pull -- --base raylib         # raylib → base eval-raylib
 *   pnpm run snapshot:pull -- --all                 # every base in scripts/fly/bases.json
 *   pnpm run snapshot:pull -- --base raylib --list  # available versions, newest last
 *   pnpm run snapshot:pull -- --base raylib --no-import   # download only
 *   pnpm run snapshot:pull -- --base raylib --into scratch --force
 *
 * Then evaluate without any indexing:
 *   pnpm run eval -- --suite raylib --skip-scan
 * or let the runner do both steps:
 *   pnpm run eval -- --suite raylib --from-snapshot
 *
 * Credentials (read-only S3 access to the snapshot bucket), in order:
 *   1. `BUCKET_NAME` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
 *      (+ optional `AWS_ENDPOINT_URL_S3`, `AWS_SESSION_TOKEN`, `AWS_REGION`).
 *   2. `FLY_API_TOKEN` — the Tigris bucket's keys are read back from the Fly
 *      extension API for `--app` (default `kb-demo`) and used for this run only.
 *      They are never written to disk.
 *
 * Behind an HTTPS proxy, run Node with `NODE_USE_ENV_PROXY=1` — Node's built-in
 * fetch ignores `HTTPS_PROXY` otherwise.
 */

import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(HERE, '..')

export const DEFAULT_BASES_MANIFEST = path.join(KB_REPO, 'scripts', 'fly', 'bases.json')
export const DEFAULT_ENDPOINT = 'https://fly.storage.tigris.dev'
export const DEFAULT_FLY_APP = 'kb-demo'
export const DEFAULT_SNAPSHOT_ROOT = 'snapshots'
export const POINTER_FILE = 'latest.json'
export const MANIFEST_FILE = 'kb-snapshot.json'
export const INDEX_FILE = '.kb-index.sqlite'
/** Mirrors SNAPSHOT_REQUIRED_FILES in scripts/fly/lib.sh — a prefix without these is torn. */
export const REQUIRED_FILES = [MANIFEST_FILE, INDEX_FILE]

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Option defaults, shared by the CLI and by programmatic callers (eval-run). */
export function defaultPullArgs(overrides = {}, env = process.env) {
  return {
    bases: [],
    all: false,
    into: null,
    doImport: true,
    outDir: null,
    version: null,
    list: false,
    force: false,
    verify: true,
    json: false,
    app: env.FLY_APP || DEFAULT_FLY_APP,
    manifest: env.BASES_MANIFEST || DEFAULT_BASES_MANIFEST,
    snapshotRoot: env.SNAPSHOT_ROOT || DEFAULT_SNAPSHOT_ROOT,
    help: false,
    ...overrides,
  }
}

export function parseArgs(argv) {
  const out = defaultPullArgs()
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    // --suite is an alias: eval suite ids and Fly base names are the same strings
    // (scripts/fly/bases.json is generated from eval/suites/*.yaml).
    if (a === '--base' || a === '--bases' || a === '--suite' || a === '--suites') {
      const next = argv[++i]
      if (!next || next.startsWith('--')) throw new Error(`${a} requires a base name`)
      out.bases.push(...next.split(',').map(s => s.trim()).filter(Boolean))
    } else if (a === '--all' || a === '--all-suites') out.all = true
    else if (a === '--into') out.into = argv[++i]
    else if (a === '--no-import') out.doImport = false
    else if (a === '--import') out.doImport = true
    else if (a === '--out') out.outDir = argv[++i]
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--list') out.list = true
    else if (a === '--force') out.force = true
    else if (a === '--no-verify') out.verify = false
    else if (a === '--json') out.json = true
    else if (a === '--app') out.app = argv[++i]
    else if (a === '--manifest') out.manifest = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown flag: ${a}`)
  }
  if (out.into && (out.all || out.bases.length > 1)) {
    throw new Error('--into targets a single base; drop it when pulling several')
  }
  return out
}

function printHelp() {
  console.log(`
pnpm run snapshot:pull — adopt the snapshot Fly.io is serving (no local rebuild)

  --base <name[,name]>   base(s) to pull; also --suite (same ids). Default: manifest default.
  --all                  every base in scripts/fly/bases.json
  --into <base>           local KB base to import into (default: eval-<name>)
  --no-import            download + verify only, do not touch a local base
  --out <dir>            download dir (default ~/.kb/snapshots/<base>/<version>)
  --version <v>          pin an immutable version instead of following latest.json
  --list                 list published versions for the base, then exit
  --force                replace an existing local index
  --no-verify            skip the sha256 integrity check (not recommended)
  --json                 machine-readable result on stdout
  --app <name>           Fly app whose Tigris bucket holds the snapshots (default ${DEFAULT_FLY_APP})
  --manifest <path>      base manifest (default scripts/fly/bases.json)

Credentials: BUCKET_NAME + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_ENDPOINT_URL_S3),
or FLY_API_TOKEN to read the Tigris keys back from the Fly extension API for --app.
`)
}

// ---------------------------------------------------------------------------
// Base manifest
// ---------------------------------------------------------------------------

export function loadBasesManifest(file = DEFAULT_BASES_MANIFEST) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bases = Array.isArray(raw.bases) ? raw.bases : []
  return {
    default: raw.default || bases.find(b => b.default)?.name || bases[0]?.name || 'kb',
    bases,
  }
}

/** Which bases this invocation pulls: explicit list → --all → the manifest default. */
export function resolveBases(args, manifest) {
  if (args.all) return manifest.bases.map(b => b.name)
  if (args.bases.length) {
    const known = new Set(manifest.bases.map(b => b.name))
    const unknown = args.bases.filter(b => !known.has(b))
    if (unknown.length) {
      throw new Error(
        `unknown base(s): ${unknown.join(', ')} — manifest has: ${[...known].join(', ')}`
      )
    }
    return [...new Set(args.bases)]
  }
  return [manifest.default]
}

/** Object-store prefix for one base: `<root>/<base>` (matches scripts/fly/lib.sh). */
export function snapshotPrefixFor(root, base) {
  return `${root}/${base}`
}

/** Local KB base a pulled snapshot lands in. Eval bases are `eval-<suite>`. */
export function defaultLocalBase(base) {
  return `eval-${base}`
}

export function kbHome(env = process.env) {
  return env.KB_HOME || path.join(os.homedir(), '.kb')
}

export function sessionDir(localBase, env = process.env) {
  return path.join(kbHome(env), 'sessions', localBase)
}

export function defaultOutDir(base, version, env = process.env) {
  return path.join(kbHome(env), 'snapshots', base, version)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function credentialsFromEnv(env = process.env) {
  const bucket = env.BUCKET_NAME || env.AWS_BUCKET_NAME
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !accessKeyId || !secretAccessKey) return null
  return {
    source: 'env',
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN || null,
    endpoint: env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || DEFAULT_ENDPOINT,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'auto',
  }
}

/**
 * Pick the Tigris bucket credentials out of a Fly extension (add-on) listing.
 *
 * Fly stores an extension's provisioned secrets in `addOn.environment` — the same
 * map `fly storage create` prints once and `fly storage update` copies onto an
 * app. Shapes vary a little across API versions (JSON scalar vs. already-parsed
 * object, app-scoped vs. org-scoped listing), so normalize defensively and pick
 * the first node that actually carries S3 keys.
 */
export function pickTigrisCredentials(addOnNodes, { bucketHint = null } = {}) {
  for (const node of addOnNodes || []) {
    if (!node) continue
    let envMap = node.environment
    if (typeof envMap === 'string') {
      try {
        envMap = JSON.parse(envMap)
      } catch {
        continue
      }
    }
    if (!envMap || typeof envMap !== 'object') continue
    const bucket = envMap.BUCKET_NAME || envMap.AWS_BUCKET_NAME || node.name
    const accessKeyId = envMap.AWS_ACCESS_KEY_ID
    const secretAccessKey = envMap.AWS_SECRET_ACCESS_KEY
    if (!bucket || !accessKeyId || !secretAccessKey) continue
    if (bucketHint && bucket !== bucketHint) continue
    return {
      source: 'fly',
      bucket,
      accessKeyId,
      secretAccessKey,
      sessionToken: envMap.AWS_SESSION_TOKEN || null,
      endpoint: envMap.AWS_ENDPOINT_URL_S3 || envMap.AWS_ENDPOINT_URL || DEFAULT_ENDPOINT,
      region: envMap.AWS_REGION || 'auto',
    }
  }
  return null
}

/**
 * Explain *why* a candidate query produced no credentials, so the operator knows
 * whether to look at the bucket or at their token. Fly returns the add-on node
 * with `environment` blanked out when the token is not scoped to read the
 * extension's secrets (deploy/agent tokens hit this), which is otherwise
 * indistinguishable from "no bucket here".
 */
export function describeAddOnMiss(addOnNodes) {
  const nodes = (addOnNodes || []).filter(Boolean)
  if (nodes.length === 0) return 'no storage add-on visible'
  const named = nodes.map(n => n?.name).filter(Boolean)
  const blanked = nodes.filter(n => {
    let envMap = n.environment
    if (typeof envMap === 'string') {
      try {
        envMap = JSON.parse(envMap)
      } catch {
        return false
      }
    }
    return envMap && typeof envMap === 'object' && Object.keys(envMap).length === 0
  })
  const seen = named.join(', ') || `${nodes.length} add-on(s)`
  if (blanked.length === nodes.length) {
    return `found ${seen} but the environment came back empty — this token cannot read extension secrets`
  }
  return `no storage add-on with S3 keys (saw ${seen})`
}

const FLY_GRAPHQL_URL = process.env.FLY_GRAPHQL_URL || 'https://api.fly.io/graphql'

/**
 * App-scoped first (the bucket that app serves from), then org-wide as a fallback.
 *
 * `AddOn` has no `type` field — the provider is `addOnProvider { name }` ("tigris").
 * Asking for `type` makes the whole query fail validation, which took out both
 * candidates at once and surfaced as a generic "did not yield bucket credentials".
 * The org fallback is load-bearing: a storage add-on provisioned with
 * `fly storage create` is attached to the organization, so the app-scoped
 * `addOns` connection can come back empty even when the bucket exists.
 */
export const FLY_ADDON_QUERIES = [
  {
    label: 'app',
    query:
      'query($appName: String!) { app(name: $appName) { addOns { nodes { id name addOnProvider { name } environment } } } }',
    variables: appName => ({ appName }),
    extract: data => data?.app?.addOns?.nodes,
  },
  {
    label: 'org',
    query:
      'query { organizations { nodes { slug addOns { nodes { id name addOnProvider { name } environment } } } } }',
    variables: () => ({}),
    extract: data => (data?.organizations?.nodes || []).flatMap(o => o?.addOns?.nodes || []),
  },
]

async function flyGraphql(token, query, variables) {
  const res = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Fly API ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '))
  return body.data
}

/** Resolve read credentials for the snapshot bucket: env first, then Fly. */
export async function resolveCredentials({ app, env = process.env, graphql = flyGraphql } = {}) {
  const fromEnv = credentialsFromEnv(env)
  if (fromEnv) return fromEnv

  const token = env.FLY_API_TOKEN || env.FLY_ACCESS_TOKEN
  if (!token) {
    throw new Error(
      'No snapshot credentials. Set BUCKET_NAME + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY ' +
        '(+ AWS_ENDPOINT_URL_S3 for non-Tigris), or FLY_API_TOKEN to read them from the Fly ' +
        'extension API. `fly storage list` shows the bucket attached to the app.'
    )
  }

  const failures = []
  for (const candidate of FLY_ADDON_QUERIES) {
    try {
      const data = await graphql(token, candidate.query, candidate.variables(app))
      const creds = pickTigrisCredentials(candidate.extract(data), {
        bucketHint: env.BUCKET_NAME || null,
      })
      if (creds) return creds
      failures.push(`${candidate.label}: ${describeAddOnMiss(candidate.extract(data))}`)
    } catch (e) {
      failures.push(`${candidate.label}: ${e instanceof Error ? e.message : e}`)
    }
  }
  throw new Error(
    `FLY_API_TOKEN did not yield bucket credentials (${failures.join(' · ')}).
Fall back to explicit creds: \`fly storage list\` / \`fly storage dashboard <id>\` for the bucket, then export BUCKET_NAME + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.`
  )
}

// ---------------------------------------------------------------------------
// Minimal S3 client (SigV4, GET + LIST only — this consumer never writes)
// ---------------------------------------------------------------------------

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()
const sha256Hex = data => createHash('sha256').update(data).digest('hex')

/** RFC 3986 escaping; `/` stays literal in an object key path. */
export function encodeKey(key) {
  return key
    .split('/')
    .map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

export function canonicalQuery(query = {}) {
  return Object.keys(query)
    .filter(k => query[k] !== undefined && query[k] !== null)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`)
    .join('&')
}

export function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzdate: iso, datestamp: iso.slice(0, 8) }
}

/**
 * SigV4 for a GET: canonical request → string to sign → signing key → Authorization.
 * Path-style addressing (`<endpoint>/<bucket>/<key>`) works on Tigris, R2, MinIO and AWS.
 */
export function signGet({ endpoint, bucket, key, query = {}, creds, now = new Date() }) {
  const url = new URL(endpoint)
  const canonicalUri = `/${bucket}${key ? `/${encodeKey(key)}` : ''}`
  const { amzdate, datestamp } = amzDate(now)
  const headers = {
    host: url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzdate,
  }
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken

  const signedHeaders = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaders.map(h => `${h}:${headers[h]}\n`).join('')
  const signedHeaderList = signedHeaders.join(';')
  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaderList,
    EMPTY_SHA256,
  ].join('\n')

  const scope = `${datestamp}/${creds.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzdate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, datestamp), creds.region), 's3'),
    'aws4_request'
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`

  const qs = canonicalQuery(query)
  return { url: `${url.origin}${canonicalUri}${qs ? `?${qs}` : ''}`, headers }
}

async function s3Get(creds, key, query) {
  const { url, headers } = signGet({
    endpoint: creds.endpoint,
    bucket: creds.bucket,
    key,
    query,
    creds,
  })
  const res = await fetch(url, { headers })
  return res
}

/** Fetch an object as a Buffer. Returns null on 404 so callers can treat it as "absent". */
export async function getObject(creds, key) {
  const res = await s3Get(creds, key)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`GET ${key} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** Extract `<Key>`/`<CommonPrefixes>` from a ListObjectsV2 response body. */
export function parseListXml(xml) {
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => decodeXml(m[1]))
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)].map(m =>
    decodeXml(m[1])
  )
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
  const tokenMatch = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)
  return { keys, prefixes, truncated, nextToken: tokenMatch ? decodeXml(tokenMatch[1]) : null }
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** List every object under a prefix (follows continuation tokens). */
export async function listObjects(creds, prefix, { delimiter = null } = {}) {
  const keys = []
  const prefixes = []
  let token = null
  do {
    const res = await s3Get(creds, '', {
      'list-type': 2,
      prefix,
      ...(delimiter ? { delimiter } : {}),
      ...(token ? { 'continuation-token': token } : {}),
    })
    if (!res.ok) {
      throw new Error(
        `LIST ${prefix} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`
      )
    }
    const parsed = parseListXml(await res.text())
    keys.push(...parsed.keys)
    prefixes.push(...parsed.prefixes)
    token = parsed.truncated ? parsed.nextToken : null
  } while (token)
  return { keys, prefixes }
}

/** Published immutable versions for a base, oldest → newest (they are sortable timestamps). */
export async function listVersions(creds, prefix) {
  const { prefixes } = await listObjects(creds, `${prefix}/`, { delimiter: '/' })
  return prefixes
    .map(p => p.slice(`${prefix}/`.length).replace(/\/$/, ''))
    .filter(Boolean)
    .sort()
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export function versionFromPointer(text) {
  if (!text) return null
  try {
    const pointer = JSON.parse(text)
    return pointer.version || null
  } catch {
    return null
  }
}

export function snapshotDirComplete(dir) {
  return REQUIRED_FILES.every(f => fs.existsSync(path.join(dir, f)))
}

/** Digest recorded by the producer for the snapshot's index (manifest `digest.index`). */
export function readSnapshotDigest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))
    return manifest?.digest?.index || null
  } catch {
    return null
  }
}

async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Decide whether a local base should be replaced by a freshly pulled snapshot.
 *
 * `kb-server import` refuses to clobber an existing index without `--force`; the
 * eval flow wants an automatic refresh when the base is *already* a snapshot of
 * an older version, but must not silently destroy a locally built index.
 */
export function planImport({ baseHasIndex, localDigest, incomingDigest, force }) {
  if (!baseHasIndex) return { action: 'import', force: false }
  if (localDigest && localDigest === incomingDigest) {
    return { action: 'skip', reason: 'base already holds this snapshot' }
  }
  if (force) return { action: 'import', force: true }
  if (localDigest) return { action: 'import', force: true, reason: 'replacing an older snapshot' }
  return {
    action: 'blocked',
    reason: 'base holds a locally built index (no kb-snapshot.json) — pass --force to replace it',
  }
}

/**
 * Index file names the snapshot carries, from an already-downloaded manifest
 * (`contents.index` = the sqlite plus any WAL/SHM). The primary index is always
 * included so a manifest predating the field still yields a usable key list.
 */
export function manifestIndexFiles(destDir) {
  let files = []
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(destDir, MANIFEST_FILE), 'utf8'))
    if (Array.isArray(manifest?.contents?.index)) {
      files = manifest.contents.index.filter(f => typeof f === 'string' && f.length > 0)
    }
  } catch {}
  return files.includes(INDEX_FILE) ? files : [INDEX_FILE, ...files]
}

/**
 * LIST-free fetch of the required objects, by exact key.
 *
 * Tigris replicates its LIST index separately from object data, so a freshly
 * published prefix can GET every key while ListObjectsV2 reports it as short —
 * or entirely empty. Observed on kb-demo: a prefix written from `lax` still
 * listed empty from `iad` nearly four hours later while both required objects
 * head-object'd 200, which crash-looped the serving node.
 *
 * The keys we need are derivable without LIST: the manifest is at a fixed name
 * and names its own index files. Mirrors `s3_pull_required` in
 * scripts/fly/lib.sh — keep the two in step.
 *
 * Aux objects (source/ast manifests, checkpoints/) are LIST-discovered only;
 * they are regenerated by a reindex and are not required to adopt a snapshot.
 */
async function downloadRequired(creds, versionPrefix, destDir, { onProgress } = {}) {
  let done = 0
  let bytes = 0
  for (const rel of [MANIFEST_FILE, ...manifestIndexFiles(destDir)]) {
    const dest = path.join(destDir, rel)
    if (fs.existsSync(dest)) continue
    const body = await getObject(creds, `${versionPrefix}/${rel}`)
    if (!body) return { files: done, bytes, complete: false }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, body)
    done++
    bytes += body.length
    onProgress?.({ done, total: REQUIRED_FILES.length, rel, bytes })
  }
  return { files: done, bytes, complete: snapshotDirComplete(destDir) }
}

export async function downloadPrefix(creds, versionPrefix, destDir, { onProgress } = {}) {
  const { keys } = await listObjects(creds, `${versionPrefix}/`)
  await fsp.rm(destDir, { recursive: true, force: true })
  await fsp.mkdir(destDir, { recursive: true })

  let done = 0
  let bytes = 0
  const queue = [...keys]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const key = queue.shift()
      if (!key) return
      const rel = key.slice(`${versionPrefix}/`.length)
      if (!rel || rel.endsWith('/')) continue
      const dest = path.join(destDir, rel)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      const body = await getObject(creds, key)
      if (!body) throw new Error(`object vanished mid-pull: ${key}`)
      await fsp.writeFile(dest, body)
      done++
      bytes += body.length
      onProgress?.({ done, total: keys.length, rel, bytes })
    }
  })
  await Promise.all(workers)

  if (!snapshotDirComplete(destDir)) {
    // LIST came back short (see downloadRequired). Every required key is
    // derivable without it, so fetch them directly before giving up — retrying
    // the LIST is not a remedy, it stayed short for hours on kb-demo.
    const recovered = await downloadRequired(creds, versionPrefix, destDir, { onProgress })
    done += recovered.files
    bytes += recovered.bytes
    if (!recovered.complete) {
      throw new Error(
        `incomplete snapshot in ${destDir} (need ${REQUIRED_FILES.join(' + ')}) — ` +
          `${versionPrefix}/ is missing required objects by LIST and by direct GET`
      )
    }
  }
  return { files: done, bytes }
}

function kbServerCommand() {
  const dist = path.join(KB_REPO, 'packages', 'kb-server', 'dist', 'bin', 'kb-server.js')
  if (fs.existsSync(dist)) return { cmd: process.execPath, args: [dist] }
  return {
    cmd: 'pnpm',
    args: ['exec', 'tsx', path.join(KB_REPO, 'packages', 'kb-server', 'src', 'index.ts')],
  }
}

function importSnapshot({ from, localBase, force, verify }) {
  const { cmd, args } = kbServerCommand()
  const argv = [...args, 'import', '--from', from, '--base', localBase]
  if (force) argv.push('--force')
  if (!verify) argv.push('--no-verify')
  const res = spawnSync(cmd, argv, { cwd: KB_REPO, stdio: 'inherit' })
  if (res.status !== 0) {
    throw new Error(`kb-server import failed (exit ${res.status ?? res.signal})`)
  }
}

/** Pull (and optionally import) one base. Returns a result record for --json. */
export async function pullBase(base, args, creds, log = console.error) {
  const prefix = snapshotPrefixFor(args.snapshotRoot, base)

  if (args.list) {
    const versions = await listVersions(creds, prefix)
    log(`[snapshot] ${base}: ${versions.length} version(s)`)
    for (const v of versions) console.log(`${base}\t${v}`)
    return { base, versions, action: 'list' }
  }

  let version = args.version
  if (!version) {
    const pointer = await getObject(creds, `${prefix}/${POINTER_FILE}`)
    version = versionFromPointer(pointer?.toString('utf8'))
    if (!version) {
      throw new Error(
        `no ${prefix}/${POINTER_FILE} in s3://${creds.bucket} — base "${base}" has never been published`
      )
    }
  }

  const outDir = args.outDir || defaultOutDir(base, version, process.env)
  const localBase = args.into || defaultLocalBase(base)

  const cached = snapshotDirComplete(outDir)
  if (cached) {
    log(`[snapshot] ${base}@${version} already downloaded → ${outDir}`)
  } else {
    log(`[snapshot] ${base}@${version} ← s3://${creds.bucket}/${prefix}/${version}/`)
    const { files, bytes } = await downloadPrefix(creds, `${prefix}/${version}`, outDir, {
      onProgress: ({ done, total, rel }) => {
        if (done === total || done % 10 === 0) log(`  · ${done}/${total} ${rel}`)
      },
    })
    log(`[snapshot] ${base}@${version} downloaded ${files} file(s), ${(bytes / 1e6).toFixed(1)} MB`)
  }

  const digest = readSnapshotDigest(outDir)
  if (args.verify) {
    const actual = await fileSha256(path.join(outDir, INDEX_FILE))
    if (digest && actual !== digest) {
      throw new Error(
        `integrity check failed for ${base}@${version}: manifest ${digest.slice(0, 12)}… vs file ${actual.slice(0, 12)}…`
      )
    }
    log(`[snapshot] ${base}@${version} sha256 ok (${(digest || actual).slice(0, 12)}…)`)
  }

  const result = {
    base,
    version,
    dir: outDir,
    localBase,
    digest,
    cached,
    imported: false,
    action: 'download',
  }
  if (!args.doImport) return result

  const targetDir = sessionDir(localBase)
  const plan = planImport({
    baseHasIndex: fs.existsSync(path.join(targetDir, INDEX_FILE)),
    localDigest: readSnapshotDigest(targetDir),
    incomingDigest: digest,
    force: args.force,
  })
  if (plan.action === 'blocked') throw new Error(`${localBase}: ${plan.reason}`)
  if (plan.action === 'skip') {
    log(`[snapshot] base "${localBase}" already holds ${base}@${version} — nothing to import`)
    result.action = 'skip-import'
    result.imported = true
    return result
  }
  if (plan.reason) log(`[snapshot] ${localBase}: ${plan.reason}`)
  importSnapshot({ from: outDir, localBase, force: plan.force, verify: args.verify })
  result.imported = true
  result.action = 'import'
  log(`[snapshot] ready: pnpm run eval -- --suite ${base} --base ${localBase} --skip-scan`)
  return result
}

/**
 * One-call entry point for other tooling (`pnpm run eval -- --from-snapshot`):
 * validate the base, resolve credentials, pull, verify, import.
 */
export async function pullSnapshotForBase({
  base,
  into = null,
  force = false,
  log = console.error,
} = {}) {
  const args = defaultPullArgs({ bases: [base], into, force })
  resolveBases(args, loadBasesManifest(args.manifest)) // throws on an unpublished base
  const creds = await resolveCredentials({ app: args.app })
  log(`[snapshot] bucket ${creds.bucket} @ ${creds.endpoint} (credentials from ${creds.source})`)
  return pullBase(base, args, creds, log)
}

export async function main(argv = process.argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`[snapshot] ${e instanceof Error ? e.message : e}`)
    return 1
  }
  if (args.help) {
    printHelp()
    return 0
  }

  let bases
  try {
    bases = resolveBases(args, loadBasesManifest(args.manifest))
  } catch (e) {
    console.error(`[snapshot] ${e instanceof Error ? e.message : e}`)
    return 1
  }

  let creds
  try {
    creds = await resolveCredentials({ app: args.app })
  } catch (e) {
    console.error(`[snapshot] ${e instanceof Error ? e.message : e}`)
    return 1
  }
  console.error(
    `[snapshot] bucket ${creds.bucket} @ ${creds.endpoint} (credentials from ${creds.source})`
  )

  const results = []
  const failures = []
  for (const base of bases) {
    try {
      results.push(await pullBase(base, args, creds))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[snapshot] ✗ ${base}: ${message}`)
      failures.push({ base, error: message })
    }
  }

  if (args.json) console.log(JSON.stringify({ results, failures }, null, 2))
  if (failures.length) {
    console.error(`[snapshot] ${failures.length}/${bases.length} base(s) failed`)
    return 1
  }
  return 0
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then(code => {
    process.exitCode = code
  })
}
