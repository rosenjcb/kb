/**
 * Prepared-state artifact contract — the vendor-agnostic handoff between a
 * high-resource KB *builder* and a low-resource KB *server*.
 *
 * A "prepared state" is a base directory (`.kb-index.sqlite`, `meta.json`, and
 * optionally the `repos/<slug>/` working trees) stamped with a
 * `kb-prepared.json` manifest that records provenance, versioning, and a content
 * digest. The manifest is what lets a serving worker *locate* and *trust* a
 * bundle produced somewhere else — on another machine, in CI, in a larger
 * container — without re-running the expensive build.
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

/** Manifest file name at the root of a prepared-state bundle / base dir. */
export const PREPARED_STATE_MANIFEST_FILE = 'kb-prepared.json'

/** Discriminator so a stray JSON file can never be mistaken for a bundle manifest. */
export const PREPARED_STATE_KIND = 'kb-prepared-state' as const

/**
 * Schema version of the manifest file itself. Bump when the manifest shape
 * changes incompatibly; consumers reject manifests newer than they understand.
 */
export const PREPARED_STATE_SCHEMA_VERSION = 1

/** Who produced the bundle, and with which KB version. */
export interface PreparedStateProducer {
  /** Producing binary, e.g. `kb-server` or `kb`. */
  tool: string
  /** `@kb/core` version that built the index (owns the on-disk format). */
  coreVersion: string
  /** Producing binary's own version (`@kb/server` / `@kb/client`), if known. */
  toolVersion?: string
}

/** Compatibility tokens a consumer checks before trusting a bundle. */
export interface PreparedStateCompat {
  /**
   * Index schema version (highest applied migration) the bundle was built with.
   * A consumer can open it only when its own `LATEST_SCHEMA_VERSION` is >= this
   * (migrations are forward-only).
   */
  indexSchema: number
}

/** Per-repo provenance, discovered from the base's git clones at export time. */
export interface PreparedStateRepoProvenance {
  gitUrl: string
  gitBranch: string
  slug: string
}

/** Where the prepared state came from — base name and source repos. */
export interface PreparedStateProvenance {
  base: string
  repos: PreparedStateRepoProvenance[]
}

/** What the bundle physically carries. */
export interface PreparedStateContents {
  /** Index file names present in the bundle, relative to its root (sqlite + any WAL/SHM). */
  index: string[]
  /**
   * Whether the `repos/<slug>/` working trees are included. Serve-only bundles
   * drop them (serving needs only the index + meta); builder bundles keep them
   * so the consumer can also refresh/reindex.
   */
  includesRepos: boolean
}

/** Integrity digest over the primary index file. */
export interface PreparedStateDigest {
  algorithm: 'sha256'
  /** Hex sha256 of the primary `.kb-index.sqlite` file. */
  index: string
}

/** The `kb-prepared.json` manifest — the prepared-state artifact contract. */
export interface PreparedStateManifest {
  kind: typeof PREPARED_STATE_KIND
  /** Manifest schema version (see PREPARED_STATE_SCHEMA_VERSION). */
  schemaVersion: number
  /** ISO-8601 timestamp the bundle was exported. */
  createdAt: string
  producer: PreparedStateProducer
  compat: PreparedStateCompat
  provenance: PreparedStateProvenance
  contents: PreparedStateContents
  digest: PreparedStateDigest
}

/** The consumer's own capabilities, checked against a manifest's requirements. */
export interface PreparedStateConsumer {
  /** Consumer's highest known index migration (defaults to this build's). */
  indexSchema: number
  /** Highest manifest schema the consumer understands (defaults to this build's). */
  manifestSchema: number
}

/** Result of comparing a manifest against a consumer. */
export interface PreparedStateCompatibility {
  ok: boolean
  /** Human-readable explanation when `ok` is false. */
  reason?: string
}

/** This build's consumer capabilities — the defaults for compatibility checks. */
export function localPreparedStateConsumer(): PreparedStateConsumer {
  return { indexSchema: LATEST_SCHEMA_VERSION, manifestSchema: PREPARED_STATE_SCHEMA_VERSION }
}

/** Map discovered base clones into manifest provenance (drops the on-disk clone dir). */
function repoProvenanceFromRepos(repos: BaseRepo[]): PreparedStateRepoProvenance[] {
  return repos.map(repo => ({
    gitUrl: repo.gitUrl,
    gitBranch: repo.gitBranch,
    slug: repo.slug,
  }))
}

/** Inputs for {@link buildPreparedStateManifest} (everything the exporter already has). */
export interface BuildPreparedStateManifestInput {
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
export function buildPreparedStateManifest(
  input: BuildPreparedStateManifestInput
): PreparedStateManifest {
  return {
    kind: PREPARED_STATE_KIND,
    schemaVersion: PREPARED_STATE_SCHEMA_VERSION,
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
 * Decide whether a consumer can safely serve from a bundle. Migrations are
 * forward-only, so an older consumer must refuse a newer bundle rather than
 * misread it. Defaults to this build's capabilities.
 */
export function checkPreparedStateCompatibility(
  manifest: PreparedStateManifest,
  consumer: PreparedStateConsumer = localPreparedStateConsumer()
): PreparedStateCompatibility {
  if (manifest.kind !== PREPARED_STATE_KIND) {
    return { ok: false, reason: `not a prepared-state manifest (kind="${manifest.kind}")` }
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
      reason: `index schema ${manifest.compat.indexSchema} is newer than this build (${consumer.indexSchema}); upgrade kb to serve this bundle`,
    }
  }
  return { ok: true }
}

/** Validate + normalize parsed JSON into a manifest, throwing on malformed input. */
export function normalizePreparedStateManifest(parsed: unknown): PreparedStateManifest {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('prepared-state manifest must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== PREPARED_STATE_KIND) {
    throw new Error(`prepared-state manifest: "kind" must be "${PREPARED_STATE_KIND}"`)
  }
  if (typeof obj.schemaVersion !== 'number' || !Number.isInteger(obj.schemaVersion)) {
    throw new Error('prepared-state manifest: "schemaVersion" must be an integer')
  }
  const producer = obj.producer as Record<string, unknown> | undefined
  if (!producer || typeof producer.tool !== 'string' || typeof producer.coreVersion !== 'string') {
    throw new Error('prepared-state manifest: "producer.tool" and "producer.coreVersion" are required strings')
  }
  const compat = obj.compat as Record<string, unknown> | undefined
  if (!compat || typeof compat.indexSchema !== 'number' || !Number.isInteger(compat.indexSchema)) {
    throw new Error('prepared-state manifest: "compat.indexSchema" must be an integer')
  }
  const provenance = obj.provenance as Record<string, unknown> | undefined
  if (!provenance || typeof provenance.base !== 'string' || !Array.isArray(provenance.repos)) {
    throw new Error('prepared-state manifest: "provenance.base" (string) and "provenance.repos" (array) are required')
  }
  const contents = obj.contents as Record<string, unknown> | undefined
  if (!contents || !Array.isArray(contents.index) || typeof contents.includesRepos !== 'boolean') {
    throw new Error('prepared-state manifest: "contents.index" (array) and "contents.includesRepos" (boolean) are required')
  }
  const digest = obj.digest as Record<string, unknown> | undefined
  if (!digest || digest.algorithm !== 'sha256' || typeof digest.index !== 'string') {
    throw new Error('prepared-state manifest: "digest" must be { algorithm: "sha256", index: <hex> }')
  }
  // Shape validated field-by-field above; the object is a well-formed manifest.
  return parsed as PreparedStateManifest
}

/** Absolute path to the manifest inside a bundle / base directory. */
export function preparedStateManifestPath(dir: string): string {
  return path.join(dir, PREPARED_STATE_MANIFEST_FILE)
}

/** Read + parse a manifest. Returns null when absent; throws on bad JSON/shape. */
export async function readPreparedStateManifest(dir: string): Promise<PreparedStateManifest | null> {
  let raw: string
  try {
    raw = await readFile(preparedStateManifestPath(dir), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `prepared-state manifest at ${preparedStateManifestPath(dir)} is not valid JSON: ${(err as Error).message}`
    )
  }
  return normalizePreparedStateManifest(parsed)
}

/** Write a manifest into a bundle / base directory (pretty-printed). */
export async function writePreparedStateManifest(
  dir: string,
  manifest: PreparedStateManifest
): Promise<void> {
  await writeFile(preparedStateManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
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
