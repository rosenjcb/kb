import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LATEST_SCHEMA_VERSION } from '@kb/core/core/db-migrations.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'
import {
  SNAPSHOT_KIND,
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshotManifest,
  checkSnapshotCompatibility,
  computeFileDigest,
  normalizeSnapshotManifest,
  readSnapshotManifest,
  writeSnapshotManifest,
} from '@kb/core/storage/snapshot.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPOS: BaseRepo[] = [
  {
    gitUrl: 'https://example.com/org/repo.git',
    gitBranch: 'main',
    slug: 'org-repo',
    dir: 'repos/org-repo',
  },
]

describe('buildSnapshotManifest', () => {
  it('stamps kind, schema, provenance, compat, and digest', () => {
    const manifest = buildSnapshotManifest({
      base: 'demo',
      repos: REPOS,
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'deadbeef',
      includesRepos: false,
      tool: 'kb-server',
      toolVersion: '9.9.9',
      createdAt: '2026-07-07T12:00:00.000Z',
    })
    expect(manifest.kind).toBe(SNAPSHOT_KIND)
    expect(manifest.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
    expect(manifest.createdAt).toBe('2026-07-07T12:00:00.000Z')
    expect(manifest.compat.indexSchema).toBe(LATEST_SCHEMA_VERSION)
    expect(manifest.contents).toEqual({ index: ['.kb-index.sqlite'], includesRepos: false })
    expect(manifest.provenance.base).toBe('demo')
    expect(manifest.provenance.repos).toEqual([
      {
        gitUrl: 'https://example.com/org/repo.git',
        gitBranch: 'main',
        slug: 'org-repo',
      },
    ])
    expect(manifest.producer).toMatchObject({ tool: 'kb-server', toolVersion: '9.9.9' })
    expect(manifest.digest).toEqual({ algorithm: 'sha256', index: 'deadbeef' })
  })

  it('omits toolVersion when not provided and tolerates empty repos', () => {
    const manifest = buildSnapshotManifest({
      base: 'demo',
      repos: [],
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'x',
      includesRepos: true,
      tool: 'kb',
    })
    expect(manifest.producer.toolVersion).toBeUndefined()
    expect(manifest.provenance.repos).toEqual([])
    expect(manifest.contents.includesRepos).toBe(true)
  })
})

describe('checkSnapshotCompatibility', () => {
  const base = buildSnapshotManifest({
    base: 'demo',
    repos: REPOS,
    indexFiles: ['.kb-index.sqlite'],
    indexDigest: 'x',
    includesRepos: false,
    tool: 'kb-server',
  })

  it('accepts a snapshot the consumer is new enough to open', () => {
    expect(checkSnapshotCompatibility(base)).toEqual({ ok: true })
    expect(
      checkSnapshotCompatibility(base, {
        indexSchema: LATEST_SCHEMA_VERSION + 5,
        manifestSchema: SNAPSHOT_SCHEMA_VERSION,
      })
    ).toEqual({ ok: true })
  })

  it('rejects a snapshot whose index schema is newer than the consumer', () => {
    const result = checkSnapshotCompatibility(base, {
      indexSchema: LATEST_SCHEMA_VERSION - 1,
      manifestSchema: SNAPSHOT_SCHEMA_VERSION,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/index schema/)
  })

  it('rejects a manifest newer than the consumer understands', () => {
    const result = checkSnapshotCompatibility(
      { ...base, schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 },
      { indexSchema: LATEST_SCHEMA_VERSION, manifestSchema: SNAPSHOT_SCHEMA_VERSION }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/manifest schema/)
  })

  it('rejects a foreign artifact whose kind is wrong', () => {
    const result = checkSnapshotCompatibility({
      ...base,
      kind: 'something-else' as typeof SNAPSHOT_KIND,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not a kb snapshot manifest/)
  })
})

describe('normalizeSnapshotManifest', () => {
  const valid = buildSnapshotManifest({
    base: 'demo',
    repos: REPOS,
    indexFiles: ['.kb-index.sqlite'],
    indexDigest: 'x',
    includesRepos: false,
    tool: 'kb-server',
  })

  it('round-trips a valid manifest', () => {
    expect(normalizeSnapshotManifest(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it.each([
    ['non-object', 42],
    ['wrong kind', { ...valid, kind: 'nope' }],
    ['missing compat', { ...valid, compat: undefined }],
    ['bad digest', { ...valid, digest: { algorithm: 'md5', index: 'x' } }],
    ['missing provenance', { ...valid, provenance: undefined }],
  ])('throws on %s', (_label, input) => {
    expect(() => normalizeSnapshotManifest(input)).toThrow()
  })
})

describe('read/write manifest + digest (IO)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kb-snapshot-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a manifest through the filesystem', async () => {
    const manifest = buildSnapshotManifest({
      base: 'demo',
      repos: REPOS,
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'x',
      includesRepos: false,
      tool: 'kb-server',
    })
    await writeSnapshotManifest(dir, manifest)
    expect(await readSnapshotManifest(dir)).toEqual(manifest)
  })

  it('returns null when no manifest is present', async () => {
    expect(await readSnapshotManifest(dir)).toBeNull()
  })

  it('computes a stable sha256 digest of a file', async () => {
    const file = path.join(dir, 'data.bin')
    writeFileSync(file, 'hello world')
    // sha256("hello world")
    expect(await computeFileDigest(file)).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    )
  })
})
