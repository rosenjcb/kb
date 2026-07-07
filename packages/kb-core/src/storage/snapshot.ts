/**
 * Snapshot artifact contract — the vendor-agnostic handoff between a
 * high-resource KB *builder* and a low-resource KB *server*.
 *
 * A "snapshot" is a base directory (`.kb-index.sqlite`, and optionally the
 * `repos/<slug>/` working trees) stamped with a `kb-snapshot.json` manifest that
 * records provenance, versioning, and a content digest. The manifest is what lets
 * a serving worker *locate* and *trust* a snapshot produced somewhere else — on
 * another machine, in CI, in a larger container — without re-running the
 * expensive build.
 *
 * This module is intentionally pure/IO-light so it is unit-testable without a
 * live index: manifest construction and the compatibility check are pure
 * functions; the only IO is reading/writing the manifest file and hashing the
 * index file for the digest.
 *
 * See `packages/kb-server/HANDOFF.md` for the full model and lifecycle.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LATEST_SCHEMA_VERSION } from '@kb/core/core/db-migrations.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'
import { KB_VERSION } from '@kb/core/version.js'

/** Manifest file name at the root of a snapshot / base dir. */
export const SNAPSHOT_MANIFEST_FILE = 'kb-snapshot.json'

/** Discriminator so a stray JSON file can never be mistaken for a snapshot manifest. */
export const SNAPSHOT_KIND = 'kb-snapshot' as const

/**
 * Schema version of the manifest file itself. Bump when the manifest shape
 * changes incompatibly; consumers reject manifests newer than they understand.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Who produced the snapshot, and with which KB version. */
export interface SnapshotProducer {
  /** Producing binary, e.g. `kb-server` or `kb`. */
  tool: string
  /** `@kb/core` version that built the index (owns the on-disk format). */
  coreVersion: string
  /** Producing binary's own version (`@kb/server` / `@kb/client`), if known. */
  toolVersion?: string
}

/** Compatibility tokens a consumer checks before trusting a snapshot. */
export interface SnapshotCompat {
  /**
   * Index schema version (highest applied migration) the snapshot was built
   * with. A consumer can open it only when its own `LATEST_SCHEMA_VERSION` is >=
   * this (migrations are forward-only).
   */
  indexSchema: number
}

/** Per-repo provenance, discovered from the base's git clones at export time. */
export interface SnapshotRepoProvenance {
  gitUrl: string
  gitBranch: string
  slug: string
  /**
   * Full SHA the index was built at. Lets a node that re-clones this repo
   * (serve-only snapshot, or a lost working tree) align the clone to the built
   * commit and detect when the remote's history has diverged from the snapshot.
   * Optional: older snapshots and unreadable clones omit it.
   */
  headSha?: string
}

/** Where the snapshot came from — base name and source repos. */
export interface SnapshotProvenance {
  base: string
  repos: SnapshotRepoProvenance[]
}

/** What the snapshot physically carries. */
export interface SnapshotContents {
  /** Index file names present in the snapshot, relative to its root (sqlite + any WAL/SHM). */
  index: string[]
  /**
   * Whether the `repos/<slug>/` working trees are included. Serve-only snapshots
   * drop them (serving needs only the index); builder snapshots keep them so the
   * consumer can also refresh/reindex.
   */
  includesRepos: boolean
}

/** Integrity digest over the primary index file. */
export interface SnapshotDigest {
  algorithm: 'sha256'
  /** Hex sha256 of the primary `.kb-index.sqlite` file. */
  index: string
}

/** The `kb-snapshot.json` manifest — the snapshot artifact contract. */
export interface SnapshotManifest {
  kind: typeof SNAPSHOT_KIND
  /** Manifest schema version (see SNAPSHOT_SCHEMA_VERSION). */
  schemaVersion: number
  /** ISO-8601 timestamp the snapshot was exported. */
  createdAt: string
  producer: SnapshotProducer
  compat: SnapshotCompat
  provenance: SnapshotProvenance
  contents: SnapshotContents
  digest: SnapshotDigest
}

/** The consumer's own capabilities, checked against a manifest's requirements. */
export interface SnapshotConsumer {
  /** Consumer's highest known index migration (defaults to this build's). */
  indexSchema: number
  /** Highest manifest schema the consumer understands (defaults to this build's). */
  manifestSchema: number
}

/** Result of comparing a manifest against a consumer. */
export interface SnapshotCompatibility {
  ok: boolean
  /** Human-readable explanation when `ok` is false. */
  reason?: string
}

/** This build's consumer capabilities — the defaults for compatibility checks. */
export function localSnapshotConsumer(): SnapshotConsumer {
  return { indexSchema: LATEST_SCHEMA_VERSION, manifestSchema: SNAPSHOT_SCHEMA_VERSION }
}

/** Map discovered base clones into manifest provenance (drops the on-disk clone dir). */
function repoProvenanceFromRepos(repos: BaseRepo[]): SnapshotRepoProvenance[] {
  return repos.map(repo => ({
    gitUrl: repo.gitUrl,
    gitBranch: repo.gitBranch,
    slug: repo.slug,
    ...(repo.headSha ? { headSha: repo.headSha } : {}),
  }))
}

/** Inputs for {@link buildSnapshotManifest} (everything the exporter already has). */
export interface BuildSnapshotManifestInput {
  base: string
  repos: BaseRepo[]
  indexFiles: string[]
  indexDigest: string
  includesRepos: boolean
  tool: string
  toolVersion?: string
  /** Override for tests; defaults to `new Date().toISOString()`. */
  createdAt?: string
}

/** Construct a manifest from data the exporter already holds — pure, no IO. */
export function buildSnapshotManifest(input: BuildSnapshotManifestInput): SnapshotManifest {
  return {
    kind: SNAPSHOT_KIND,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    producer: {
      tool: input.tool,
      coreVersion: KB_VERSION,
      ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
    },
    compat: { indexSchema: LATEST_SCHEMA_VERSION },
    provenance: { base: input.base, repos: repoProvenanceFromRepos(input.repos) },
    contents: { index: input.indexFiles, includesRepos: input.includesRepos },
    digest: { algorithm: 'sha256', index: input.indexDigest },
  }
}

/**
 * Decide whether a consumer can safely serve from a snapshot. Migrations are
 * forward-only, so an older consumer must refuse a newer snapshot rather than
 * misread it. Defaults to this build's capabilities.
 */
export function checkSnapshotCompatibility(
  manifest: SnapshotManifest,
  consumer: SnapshotConsumer = localSnapshotConsumer()
): SnapshotCompatibility {
  if (manifest.kind !== SNAPSHOT_KIND) {
    return { ok: false, reason: `not a kb snapshot manifest (kind="${manifest.kind}")` }
  }
  if (manifest.schemaVersion > consumer.manifestSchema) {
    return {
      ok: false,
      reason: `manifest schema ${manifest.schemaVersion} is newer than this build understands (${consumer.manifestSchema}); upgrade kb`,
    }
  }
  if (manifest.compat.indexSchema > consumer.indexSchema) {
    return {
      ok: false,
      reason: `index schema ${manifest.compat.indexSchema} is newer than this build (${consumer.indexSchema}); upgrade kb to serve this snapshot`,
    }
  }
  return { ok: true }
}

/** Validate + normalize parsed JSON into a manifest, throwing on malformed input. */
export function normalizeSnapshotManifest(parsed: unknown): SnapshotManifest {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('kb snapshot manifest must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== SNAPSHOT_KIND) {
    throw new Error(`kb snapshot manifest: "kind" must be "${SNAPSHOT_KIND}"`)
  }
  if (typeof obj.schemaVersion !== 'number' || !Number.isInteger(obj.schemaVersion)) {
    throw new Error('kb snapshot manifest: "schemaVersion" must be an integer')
  }
  const producer = obj.producer as Record<string, unknown> | undefined
  if (!producer || typeof producer.tool !== 'string' || typeof producer.coreVersion !== 'string') {
    throw new Error(
      'kb snapshot manifest: "producer.tool" and "producer.coreVersion" are required strings'
    )
  }
  const compat = obj.compat as Record<string, unknown> | undefined
  if (!compat || typeof compat.indexSchema !== 'number' || !Number.isInteger(compat.indexSchema)) {
    throw new Error('kb snapshot manifest: "compat.indexSchema" must be an integer')
  }
  const provenance = obj.provenance as Record<string, unknown> | undefined
  if (!provenance || typeof provenance.base !== 'string' || !Array.isArray(provenance.repos)) {
    throw new Error(
      'kb snapshot manifest: "provenance.base" (string) and "provenance.repos" (array) are required'
    )
  }
  const contents = obj.contents as Record<string, unknown> | undefined
  if (!contents || !Array.isArray(contents.index) || typeof contents.includesRepos !== 'boolean') {
    throw new Error(
      'kb snapshot manifest: "contents.index" (array) and "contents.includesRepos" (boolean) are required'
    )
  }
  const digest = obj.digest as Record<string, unknown> | undefined
  if (!digest || digest.algorithm !== 'sha256' || typeof digest.index !== 'string') {
    throw new Error('kb snapshot manifest: "digest" must be { algorithm: "sha256", index: <hex> }')
  }
  // Shape validated field-by-field above; the object is a well-formed manifest.
  return parsed as SnapshotManifest
}

/** Absolute path to the manifest inside a snapshot / base directory. */
export function snapshotManifestPath(dir: string): string {
  return path.join(dir, SNAPSHOT_MANIFEST_FILE)
}

/** Read + parse a manifest. Returns null when absent; throws on bad JSON/shape. */
export async function readSnapshotManifest(dir: string): Promise<SnapshotManifest | null> {
  let raw: string
  try {
    raw = await readFile(snapshotManifestPath(dir), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `kb snapshot manifest at ${snapshotManifestPath(dir)} is not valid JSON: ${(err as Error).message}`
    )
  }
  return normalizeSnapshotManifest(parsed)
}

/** Write a manifest into a snapshot / base directory (pretty-printed). */
export async function writeSnapshotManifest(
  dir: string,
  manifest: SnapshotManifest
): Promise<void> {
  await writeFile(snapshotManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** Streaming sha256 of a file, hex-encoded — used for the index digest. */
export function computeFileDigest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
