/**
 * `kb-server export` / `kb-server import` — the snapshot handoff mechanics.
 *
 * A high-resource *builder* runs `export` to snapshot a fully-built base into a
 * portable directory (mirroring the base layout plus a `kb-snapshot.json`
 * manifest). A low-resource *server* consumes that snapshot — either via the
 * explicit `import` step, or directly at boot with `kb-server start --from <dir>`
 * — and serves it without repeating the expensive build.
 *
 * The snapshot is a plain directory so it is transport-agnostic: tar it, rsync
 * it, push it to an object store, or mount it — the manifest travels with the
 * bytes and lets the consumer verify provenance, integrity, and compatibility.
 * The consumer never downloads anything: it reads state already present on the
 * local filesystem.
 *
 * Layout of an exported snapshot (a faithful copy of the base):
 *
 *   <out>/
 *     kb-snapshot.json      # manifest (provenance, compat, digest)
 *     .kb-index.sqlite       # the built index (one consistent file, no sidecars)
 *     source-files-manifest.json, ast-files-manifest.json, checkpoints/, …  # settings
 *     repos/<slug>/         # source working trees — dropped by --no-repos
 *
 * An export carries the whole base by default. `--no-repos` drops the working
 * trees for a small serve-only artifact; the manifest still records each repo's
 * URL, branch, and built SHA (from the clones at export time), so a consumer can
 * re-clone them from provenance and keep indexing even when the trees are excluded.
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import {
  ensureOperationalBaseDir,
  readOptionalCliValue,
  resolveEffectiveBaseDir,
} from '@kb/core/storage/base-selection.js'
import {
  SNAPSHOT_MANIFEST_FILE,
  type SnapshotManifest,
  type SnapshotProducer,
  buildSnapshotManifest,
  checkSnapshotCompatibility,
  computeFileDigest,
  readSnapshotManifest,
  writeSnapshotManifest,
} from '@kb/core/storage/snapshot.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import type { ServerLogger } from './server-cli.js'

const INDEX_BASENAME = '.kb-index.sqlite'
const REPOS_DIRNAME = 'repos'

/** User-facing producer label — binary + toolVersion only (never coreVersion). */
export function formatSnapshotProducer(producer: SnapshotProducer): string {
  return producer.toolVersion ? `${producer.tool}@${producer.toolVersion}` : producer.tool
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Snapshot the live index into a single, crash-consistent file via SQLite's
 * `VACUUM INTO`. This takes a read transaction, so it is safe against a running
 * builder (no quiesce needed) and folds any WAL back into the main file — the
 * snapshot therefore carries exactly one `.kb-index.sqlite` with no sidecars, and
 * the manifest digest covers the whole state.
 */
function snapshotIndex(srcIndexPath: string, destIndexPath: string): void {
  const db = new DatabaseSync(srcIndexPath)
  try {
    // Single-quoted SQL string literal; double any embedded quote.
    db.exec(`VACUUM INTO '${destIndexPath.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

/** Resolve the base dir to operate on: `--base <name|path>` if given, else the effective base. */
async function resolveBaseDir(args: string[], cwd: string): Promise<string> {
  const base = readOptionalCliValue(args, '--base')
  if (base) return ensureOperationalBaseDir(base, cwd)
  return (await resolveEffectiveBaseDir(cwd)).baseDir
}

export interface ExportOptions {
  /** Snapshot output directory. */
  out: string
  /** Carry the `repos/<slug>/` working trees. Default true; `--no-repos` opts out. */
  includeRepos: boolean
  /** Overwrite a non-empty output directory. */
  force: boolean
}

function parseExportOptions(args: string[]): ExportOptions {
  const out = readOptionalCliValue(args, '--out')
  if (!out) throw new Error('kb-server export requires --out <dir>')
  // A snapshot is a faithful export: repos and all base settings travel by default.
  // `--no-repos` drops the working trees for a small, frozen serve-only artifact;
  // `--with-repos` is accepted as a no-op for back-compat.
  return {
    out: path.resolve(out),
    includeRepos: !args.includes('--no-repos'),
    force: args.includes('--force'),
  }
}

/** True for base entries the export handles specially (the live index, replaced by a
 *  VACUUM'd copy; the manifest, rewritten fresh; the repos dir when `--no-repos`). */
function skipBaseEntry(name: string, includeRepos: boolean): boolean {
  if (name === INDEX_BASENAME || name.startsWith(`${INDEX_BASENAME}-`)) return true // sqlite + -wal/-shm
  if (name === SNAPSHOT_MANIFEST_FILE) return true
  if (!includeRepos && name === REPOS_DIRNAME) return true
  return false
}

/**
 * `kb-server export [--base <name>] --out <dir> [--no-repos] [--force]`
 *
 * Snapshots a built base into a portable snapshot directory. The export is
 * faithful: the consistent index plus every other base file — the scan/AST
 * manifests, checkpoints, and (unless `--no-repos`) the repo working trees — so a
 * consumer restores the full built state and can keep indexing from it.
 */
export async function runExportCommand(
  args: string[],
  out: ServerLogger,
  cwd: string = process.cwd()
): Promise<void> {
  const opts = parseExportOptions(args)
  const baseDir = await resolveBaseDir(args, cwd)
  const baseName = path.basename(baseDir)

  const indexPath = kbIndexDbPath(baseDir)
  if (!(await pathExists(indexPath))) {
    throw new Error(
      `No index at ${indexPath} — nothing to export. Build the base first (\`kb init\` / \`kb-server start\`).`
    )
  }

  if (await pathExists(opts.out)) {
    const existing = await readdir(opts.out).catch(() => [] as string[])
    if (existing.length > 0 && !opts.force) {
      throw new Error(`Output directory ${opts.out} is not empty; pass --force to overwrite.`)
    }
    if (opts.force) await rm(opts.out, { recursive: true, force: true })
  }
  await mkdir(opts.out, { recursive: true })

  // Capture provenance (incl. each clone's built SHA) before we copy anything.
  const repos = await discoverBaseRepos(baseDir)

  // Snapshot the index into one consistent file (safe against a live base).
  const bundledIndexPath = path.join(opts.out, INDEX_BASENAME)
  snapshotIndex(indexPath, bundledIndexPath)
  const indexFiles = [INDEX_BASENAME]

  // Faithfully carry the rest of the base: scan/AST manifests, checkpoints, any
  // settings, and the repo working trees (unless --no-repos). The live sqlite
  // files and the old manifest are skipped — they are re-derived above/below.
  const baseHasRepos = await pathExists(path.join(baseDir, REPOS_DIRNAME))
  for (const name of await readdir(baseDir)) {
    if (skipBaseEntry(name, opts.includeRepos)) continue
    await cp(path.join(baseDir, name), path.join(opts.out, name), { recursive: true })
  }
  const includesRepos = opts.includeRepos && baseHasRepos

  const manifest = buildSnapshotManifest({
    base: baseName,
    repos,
    indexFiles,
    indexDigest: await computeFileDigest(bundledIndexPath),
    includesRepos,
    tool: 'kb-server',
    toolVersion: await readServerVersion(),
  })
  await writeSnapshotManifest(opts.out, manifest)

  out.log(`📦 Exported snapshot for base "${baseName}" → ${opts.out}`)
  out.log(
    `   index schema ${manifest.compat.indexSchema} · ${manifest.provenance.repos.length} repo(s) · repos ${includesRepos ? 'included' : 'excluded (serve-only)'}`
  )
  for (const repo of manifest.provenance.repos) {
    out.log(`   ${repo.slug} @ ${repo.gitBranch} (${repo.gitUrl})`)
  }
  out.log(`   manifest: ${path.join(opts.out, SNAPSHOT_MANIFEST_FILE)}`)
}

export interface AdoptSnapshotOptions {
  /** Snapshot source directory (already present on the local filesystem). */
  from: string
  /** Target base directory to restore into. */
  baseDir: string
  /** Overwrite an existing index in the target base. */
  force: boolean
  /** Check the sha256 integrity of the snapshot index before restoring. */
  verify: boolean
}

/**
 * Restore a local snapshot directory into a base after verifying its manifest,
 * compatibility, and (optionally) index integrity. Refuses to clobber an
 * existing index unless `force`. Never downloads — the snapshot must already be
 * on local disk. Shared by `kb-server import` and `kb-server start --from`.
 */
export async function adoptSnapshot(opts: AdoptSnapshotOptions): Promise<SnapshotManifest> {
  const manifest = await readSnapshotManifest(opts.from)
  if (!manifest) {
    throw new Error(`No ${SNAPSHOT_MANIFEST_FILE} in ${opts.from} — not a kb snapshot.`)
  }

  const compat = checkSnapshotCompatibility(manifest)
  if (!compat.ok) {
    throw new Error(`Incompatible snapshot: ${compat.reason}`)
  }

  const primaryIndex = manifest.contents.index[0] ?? INDEX_BASENAME
  const bundledIndexPath = path.join(opts.from, primaryIndex)
  if (!(await pathExists(bundledIndexPath))) {
    throw new Error(
      `Snapshot manifest lists ${primaryIndex} but the file is missing from ${opts.from}.`
    )
  }
  if (opts.verify) {
    const digest = await computeFileDigest(bundledIndexPath)
    if (digest !== manifest.digest.index) {
      throw new Error(
        `Integrity check failed for ${primaryIndex}: expected ${manifest.digest.index.slice(0, 12)}…, got ${digest.slice(0, 12)}… (pass --no-verify to override).`
      )
    }
  }

  const targetIndex = kbIndexDbPath(opts.baseDir)
  const baseName = path.basename(opts.baseDir)
  if ((await pathExists(targetIndex)) && !opts.force) {
    throw new Error(
      `Base "${baseName}" already has an index at ${targetIndex}; pass --force to replace it.`
    )
  }

  // Restore the snapshot faithfully: the index, the manifest, and every other
  // file it carries (scan/AST manifests, checkpoints, settings, and — when
  // present — the repo working trees). Mirrors the faithful export above.
  await mkdir(opts.baseDir, { recursive: true })
  for (const name of await readdir(opts.from)) {
    await cp(path.join(opts.from, name), path.join(opts.baseDir, name), { recursive: true })
  }

  return manifest
}

export interface ImportOptions {
  /** Snapshot source directory. */
  from: string
  /** Overwrite an existing index in the target base. */
  force: boolean
  /** Skip the sha256 integrity check of the snapshot index. */
  noVerify: boolean
}

function parseImportOptions(args: string[]): ImportOptions {
  const from = readOptionalCliValue(args, '--from')
  if (!from) throw new Error('kb-server import requires --from <dir>')
  return {
    from: path.resolve(from),
    force: args.includes('--force'),
    noVerify: args.includes('--no-verify'),
  }
}

/**
 * `kb-server import --from <dir> [--base <name>] [--force] [--no-verify]`
 *
 * Restores a snapshot into a base for a later `kb-server start`. This is the
 * explicit two-step path; `kb-server start --from <dir>` fuses restore + serve.
 */
export async function runImportCommand(
  args: string[],
  out: ServerLogger,
  cwd: string = process.cwd()
): Promise<void> {
  const opts = parseImportOptions(args)
  const baseDir = await resolveBaseDir(args, cwd)
  const baseName = path.basename(baseDir)

  const manifest = await adoptSnapshot({
    from: opts.from,
    baseDir,
    force: opts.force,
    verify: !opts.noVerify,
  })

  out.log(`📥 Imported snapshot into base "${baseName}" (${baseDir})`)
  out.log(
    `   built by ${formatSnapshotProducer(manifest.producer)} · index schema ${manifest.compat.indexSchema} · ${manifest.provenance.repos.length} repo(s)`
  )
  out.log(`   start serving: kb-server start --base ${baseName}`)
}

/** Best-effort read of the `@kb/server` package version for manifest provenance. */
async function readServerVersion(): Promise<string | undefined> {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const { readFile } = await import('node:fs/promises')
      const url = new URL(rel, import.meta.url)
      const pkg = JSON.parse(await readFile(url, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === '@kb/server' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined
}
